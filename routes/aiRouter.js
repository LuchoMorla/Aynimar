'use strict';

const express  = require('express');
const passport = require('passport');
const OpenAI   = require('openai');
const { checkRoles }        = require('../middlewares/authHandler');
const { optimizeProductCopy } = require('../integrations/aiCopyService');

const router = express.Router();

// ── Groq client (OpenAI-compatible) ─────────────────────────────────────────
// Initialized lazily per-request so a missing key returns a clean 503
// instead of crashing the module at boot.
function getGroqClient() {
  const apiKey = process.env.GROQ_IA_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });
}

const NUTRIA_SYSTEM_PROMPT =
  'Eres NutrIA, la nutria asistente oficial de Aynimar, una plataforma de ' +
  'e-commerce circular en Quito, Ecuador. Tu objetivo es ayudar amigablemente ' +
  'a los usuarios a completar sus compras en el checkout, resolver dudas de ' +
  'envío, y motivarlos a cumplir retos de reciclaje para ganar Ayni-Créditos. ' +
  'Habla de forma muy carismática, usa jerga ecuatoriana sutil y educada ' +
  "('¡Hola, de una!', '¿en qué te ayudo, ve?'), y mantén tus respuestas " +
  'cortas, directas y enfocadas en la conversión o el reciclaje.';

// ── POST /api/v1/ai/nutria/chat ──────────────────────────────────────────────
// Public endpoint — proxy hacia Groq. Recibe { message, history? } y
// devuelve { reply }. No requiere autenticación (widget público).
router.post('/nutria/chat', async (req, res, next) => {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ message: 'Se requiere el campo "message".' });
    }

    const groq = getGroqClient();
    if (!groq) {
      console.error('[NutrIA] GROQ_IA_KEY no configurada en Railway.');
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    const model = (process.env.GROQ_MODEL || 'llama-3.1-8b-instant').trim();

    const safeHistory = Array.isArray(history)
      ? history.filter(
          (m) =>
            m &&
            typeof m.role === 'string' &&
            typeof m.content === 'string' &&
            ['user', 'assistant'].includes(m.role)
        )
      : [];

    const messages = [
      { role: 'system', content: NUTRIA_SYSTEM_PROMPT },
      ...safeHistory,
      { role: 'user', content: message.trim() },
    ];

    console.log(`[NutrIA] → Groq  model="${model}"  msgs=${messages.length}`);

    const completion = await groq.chat.completions.create({ model, messages });

    const reply = completion.choices?.[0]?.message?.content ?? '';
    console.log(`[NutrIA] ✓ reply (${reply.length} chars)`);

    return res.json({ reply });
  } catch (err) {
    console.error(`[NutrIA] Error inesperado: ${err.message}`);
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
