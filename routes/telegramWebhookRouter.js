'use strict';

/**
 * Telegram Webhook — Dropi 2FA Manual Failover
 *
 * Flow:
 *   1. autoRefreshToken() fails all TOTP windows → sends Telegram alert to CEO
 *   2. CEO replies with the 6-digit OTP code
 *   3. Telegram POSTs update to this webhook
 *   4. We call completeManual2FA(code) → saves token to DB
 *   5. Reply to Telegram with success/failure message
 *
 * Required Railway env vars:
 *   TELEGRAM_BOT_TOKEN        — bot token from @BotFather
 *   TELEGRAM_CHAT_ID          — CEO's personal chat ID (@userinfobot to get it)
 *   TELEGRAM_WEBHOOK_SECRET   — optional; set when registering the webhook with Telegram
 *                               (Telegram sends it as X-Telegram-Bot-Api-Secret-Token header)
 *
 * Register the webhook once with:
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *        -d "url=https://<railway-url>/telegram/webhook" \
 *        -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
 */

const express = require('express');
const { completeManual2FA }     = require('../integrations/dropi/dropiAuthService');
const { set2FAStatus }          = require('../integrations/dropi/dropiTokenService');

const router = express.Router();

const _reply = async (chatId, text) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal:  controller.signal,
    });
  } catch (err) {
    console.error('[Telegram Webhook] Error enviando respuesta:', err.message);
  } finally {
    clearTimeout(timer);
  }
};

router.post('/', async (req, res) => {
  // Validate Telegram secret token header if configured.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== expectedSecret) {
      console.warn('[Telegram Webhook] Rejected: invalid secret token.');
      return res.sendStatus(403);
    }
  }

  // Acknowledge immediately — Telegram retries if we don't respond within 3 s.
  res.sendStatus(200);

  const update  = req.body;
  const message = update?.message || update?.edited_message;
  if (!message) return;

  const chatId   = message.chat?.id;
  const fromId   = message.from?.id;
  const text     = (message.text || '').trim();

  // Only process messages from the configured CEO chat.
  const allowedChatId = process.env.TELEGRAM_CHAT_ID;
  if (!allowedChatId || String(chatId) !== String(allowedChatId)) {
    console.warn(`[Telegram Webhook] Mensaje ignorado de chat_id=${chatId} (no autorizado).`);
    return;
  }

  // Extract the 2FA code — accept 6-digit code, optionally prefixed with /code or similar.
  const codeMatch = text.match(/\b(\d{6})\b/);
  if (!codeMatch) {
    console.log(`[Telegram Webhook] Mensaje recibido pero sin código 6 dígitos: "${text}"`);
    await _reply(chatId, '⚠️ No encontré un código de 6 dígitos en tu mensaje. Por favor envía solo el código (ej: <code>123456</code>).');
    return;
  }

  const code = codeMatch[1];
  console.log(`[Telegram Webhook] Código 2FA recibido del CEO: ${code}`);

  try {
    await completeManual2FA(code);
    await set2FAStatus('').catch(() => {});
    await _reply(chatId, '✅ <b>Autenticación exitosa.</b>\n\nEl token de Dropi ha sido renovado. Puedes reintentar la importación desde el dashboard.');
    console.log('[Telegram Webhook] Login manual completado y CEO notificado.');
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Error desconocido';
    await _reply(chatId, `❌ <b>Error de autenticación.</b>\n\n${msg}\n\nVerifica el código e inténtalo de nuevo.`);
    console.error('[Telegram Webhook] Login manual fallido:', msg);
  }
});

module.exports = router;
