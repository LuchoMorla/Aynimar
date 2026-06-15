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
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ message: 'Se requiere el campo "message".' });
    }

    const ollamaUrl = process.env.OLLAMA_URL;
    if (!ollamaUrl) {
      return res.status(503).json({ message: 'Servicio de IA no disponible.' });
    }

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

    const headers = { 'Content-Type': 'application/json' };
    if (process.env.OLLAMA_AYNI_NUTRIA_KEY) {
      headers['Authorization'] = `Bearer ${process.env.OLLAMA_AYNI_NUTRIA_KEY}`;
    }

    const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'gemma2',
        messages,
        stream: false,
      }),
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      console.error(`[NutrIA] Ollama error ${ollamaRes.status}:`, errText);
      return res.status(502).json({ message: 'Error al contactar el modelo de IA.' });
    }

    const data = await ollamaRes.json();
    const reply = data.message?.content ?? '';

    return res.json({ reply });
  } catch (err) {
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
