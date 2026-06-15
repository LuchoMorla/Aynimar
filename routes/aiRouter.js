'use strict';

const express  = require('express');
const passport = require('passport');
const { checkRoles } = require('../middlewares/authHandler');
const { optimizeProductCopy } = require('../integrations/aiCopyService');

const router = express.Router();

// ── Ollama URL resolver ───────────────────────────────────────────────────────
// Reads from OLLAMA_URL first, then fallback aliases, then any key that
// contains "OLLAMA" in its name. Trims whitespace and trailing slashes so
// values pasted into Railway's UI don't produce double-slash URLs.
const OLLAMA_URL_ALIASES = ['OLLAMA_URL', 'OLLAMA_HOST', 'NEXT_PUBLIC_OLLAMA_URL'];

function resolveOllamaUrl() {
  for (const key of OLLAMA_URL_ALIASES) {
    const raw = process.env[key];
    if (raw && raw.trim()) {
      return raw.trim().replace(/\/+$/, '');
    }
  }
  // Last-resort scan: any env key containing "OLLAMA" that looks like a URL
  const fallbackKey = Object.keys(process.env).find(
    (k) =>
      k.toUpperCase().includes('OLLAMA') &&
      !k.toUpperCase().includes('KEY') &&
      !k.toUpperCase().includes('MODEL') &&
      process.env[k]?.trim().startsWith('http')
  );
  if (fallbackKey) {
    return process.env[fallbackKey].trim().replace(/\/+$/, '');
  }
  return null;
}

// Log available OLLAMA vars once at module load — visible in Railway boot logs
const _ollamaVarsAtBoot = Object.keys(process.env)
  .filter((k) => k.toUpperCase().includes('OLLAMA'))
  .map((k) => `${k}=${(process.env[k] || '').trim().slice(0, 40) || '(vacío)'}`)
  .join(' | ');
console.log('[NutrIA] Variables OLLAMA al arrancar:', _ollamaVarsAtBoot || '(ninguna detectada)');

const NUTRIA_SYSTEM_PROMPT =
  'Eres NutrIA, la nutria asistente oficial de Aynimar, una plataforma de ' +
  'e-commerce circular en Quito, Ecuador. Tu objetivo es ayudar amigablemente ' +
  'a los usuarios a completar sus compras en el checkout, resolver dudas de ' +
  'envío, y motivarlos a cumplir retos de reciclaje para ganar Ayni-Créditos. ' +
  'Habla de forma muy carismática, usa jerga ecuatoriana sutil y educada ' +
  "('¡Hola, de una!', '¿en qué te ayudo, ve?'), y mantén tus respuestas " +
  'cortas, directas y enfocadas en la conversión o el reciclaje.';

// ── POST /api/v1/ai/nutria/chat ──────────────────────────────────────────────
// Public endpoint — proxy hacia Ollama. Recibe { message, history? } y
// devuelve { reply }. No requiere autenticación (widget público).
router.post('/nutria/chat', async (req, res, next) => {
  let ollamaUrl;
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ message: 'Se requiere el campo "message".' });
    }

    ollamaUrl = resolveOllamaUrl();
    const model   = (process.env.OLLAMA_MODEL           || 'gemma2').trim();
    const authKey = (process.env.OLLAMA_AYNI_NUTRIA_KEY || '').trim();

    if (!ollamaUrl) {
      const detected = Object.keys(process.env)
        .filter((k) => k.toUpperCase().includes('OLLAMA'))
        .join(', ');
      console.error(
        `[NutrIA] Sin URL de Ollama. Variables detectadas en Railway: [${detected || 'ninguna'}]`
      );
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    console.log(
      `[NutrIA] Iniciando proxy → url="${ollamaUrl}/api/chat"  model="${model}"  key=${authKey ? '✓' : '✗'}`
    );

    const safeHistory = Array.isArray(history)
      ? history.filter(
          (m) =>
            m &&
            typeof m.role === 'string' &&
            typeof m.content === 'string' &&
            ['user', 'assistant'].includes(m.role)
        )
      : [];

    const ollamaMessages = [
      { role: 'system', content: NUTRIA_SYSTEM_PROMPT },
      ...safeHistory,
      { role: 'user', content: message.trim() },
    ];

    // Build headers — cover Ngrok free-tier (skips browser warning page),
    // plus both Authorization and custom header for custom tunnel proxies.
    const headers = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
    };
    if (authKey) {
      headers['Authorization'] = `Bearer ${authKey}`;
      headers['X-Ayni-Key']    = authKey;
    }

    // Abort after 30 s to avoid Railway request timeouts
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 30000);

    let ollamaRes;
    try {
      ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: ollamaMessages, stream: false }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => '');
      console.error(`[NutrIA] Ollama HTTP ${ollamaRes.status}:`, errText.slice(0, 300));
      return res.status(502).json({
        message: `Error del modelo (${ollamaRes.status}). Inténtalo de nuevo.`,
      });
    }

    const data = await ollamaRes.json();

    // Extract reply from any of the three common formats:
    //   Ollama /api/chat      → { message: { content } }
    //   OpenAI-compatible     → { choices: [{ message: { content } }] }
    //   Ollama /api/generate  → { response }
    const reply =
      data.message?.content ??
      data.choices?.[0]?.message?.content ??
      data.response ??
      '';

    console.log(`[NutrIA] ✓ reply (${reply.length} chars) via format=${
      data.message ? 'ollama-chat' : data.choices ? 'openai' : data.response !== undefined ? 'ollama-generate' : 'unknown'
    }`);

    return res.json({ reply });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[NutrIA] Timeout alcanzado para ${ollamaUrl}`);
      return res.status(504).json({ message: 'NutrIA tardó demasiado en responder. Inténtalo de nuevo.' });
    }
    console.error(`[NutrIA] Error inesperado: ${err.message}  (code: ${err.code ?? 'n/a'})`);
    next(err);
  }
});

// ── POST /api/v1/ai/optimize-copy ────────────────────────────────────────────
// Receives { text } and returns AI-optimized e-commerce copy.
// Used by the Dropi importer's "Optimizar con IA" button.

router.post(
  '/optimize-copy',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string' || text.trim().length < 5) {
        return res.status(400).json({ message: 'Body debe contener { text: "descripción del producto" }' });
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ message: 'ANTHROPIC_API_KEY no configurada en el servidor.' });
      }
      const optimized = await optimizeProductCopy(text.trim());
      if (!optimized) {
        return res.status(502).json({ message: 'La IA no pudo procesar el texto. Inténtalo de nuevo.' });
      }
      return res.json({ optimized });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
