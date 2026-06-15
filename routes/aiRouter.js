'use strict';

const express  = require('express');
const passport = require('passport');
const { checkRoles } = require('../middlewares/authHandler');
const { optimizeProductCopy } = require('../integrations/aiCopyService');

const router = express.Router();

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

    ollamaUrl = process.env.OLLAMA_URL;
    const model   = process.env.OLLAMA_MODEL          || 'gemma2';
    const authKey = process.env.OLLAMA_AYNI_NUTRIA_KEY || '';

    if (!ollamaUrl) {
      console.error('[NutrIA] OLLAMA_URL no configurada en las variables de entorno.');
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    console.log(`[NutrIA] → ${ollamaUrl}/api/chat  model=${model}  key=${authKey ? '✓' : '✗'}`);

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

    const data  = await ollamaRes.json();
    const reply = data.message?.content ?? '';
    console.log(`[NutrIA] ✓ reply (${reply.length} chars)`);

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
