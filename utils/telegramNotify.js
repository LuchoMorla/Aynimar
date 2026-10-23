'use strict';
/* global FormData */

const fs = require('fs');
const { getTelegramToken, getAdminChatId, signCallbackData, isProductionEnv } = require('../libs/telegramSecurity');

// Fuera de producción (staging, local) los avisos llegan rotulados: el propietario
// no debe confundir un pedido de prueba con una venta real.
const NON_PROD_TAG = '🧪 <b>PRUEBA · STAGING — no es una venta real</b>\n';

async function sendTelegramNotification(text) {
  const token  = getTelegramToken();
  const chatId = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;
  if (!isProductionEnv()) text = NON_PROD_TAG + text;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) console.warn(`[TelegramNotify] Telegram rechazó el envío: ${data.error_code ?? resp.status} ${data.description ?? ''}`);
  } catch (err) {
    console.warn('[TelegramNotify] Failed to send notification:', err.message);
  }
}

/**
 * Envía un mp4 al admin para revisión con botones firmados Aprobar/Rechazar/Cambios.
 * Caption en texto plano (sin parse_mode): incluye datos de producto.
 * Los botones los procesa POST /api/v1/ai/telegram/webhook (F2).
 * @returns {Promise<{ok: boolean, fileId?: string, messageId?: number}>}
 */
async function sendTelegramVideo(filePath, caption, ref) {
  const token  = getTelegramToken();
  const chatId = getAdminChatId();
  if (!token || !chatId) {
    console.warn('[TelegramNotify] Telegram no configurado (token/chat ausente o bloqueado en este entorno).');
    return { ok: false };
  }
  const buttons = [['ap', 'Aprobar'], ['rj', 'Rechazar'], ['ch', 'Cambios']]
    .map(([a, text]) => ({ text, callback_data: signCallbackData(a, ref) }));
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', String(caption).slice(0, 1024));
  form.append('supports_streaming', 'true');
  if (buttons.every((b) => b.callback_data)) form.append('reply_markup', JSON.stringify({ inline_keyboard: [buttons] }));
  else console.warn('[TelegramNotify] Sin TELEGRAM_WEBHOOK_SECRET o ref inválido: vídeo enviado sin botones.');
  form.append('video', await fs.openAsBlob(filePath, { type: 'video/mp4' }), 'video.mp4');
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) {
      console.warn(`[TelegramNotify] Telegram rechazó el vídeo: ${data.error_code ?? resp.status} ${data.description ?? ''}`);
      return { ok: false };
    }
    return { ok: true, fileId: data.result?.video?.file_id, messageId: data.result?.message_id };
  } catch (err) {
    console.warn('[TelegramNotify] Failed to send video:', err.message);
    return { ok: false };
  }
}

/**
 * Llamada genérica a la Bot API (JSON). Nunca lanza ni registra el token.
 * @returns {Promise<object|null>} result de Telegram, o null si falla.
 */
async function callTelegram(method, payload) {
  const token = getTelegramToken();
  if (!token) return null;
  try {
    // FormData (subida de archivo, p. ej. sendVideo con bytes) → multipart y timeout largo.
    const isForm = payload instanceof FormData;
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:  'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body:    isForm ? payload : JSON.stringify(payload),
      signal:  AbortSignal.timeout(isForm ? 120000 : 15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) {
      console.warn(`[TelegramNotify] ${method} rechazado: ${data.error_code ?? resp.status} ${data.description ?? ''}`);
      return null;
    }
    return data.result ?? true;
  } catch (err) {
    console.warn(`[TelegramNotify] ${method} falló:`, err.name);
    return null;
  }
}

module.exports = { sendTelegramNotification, sendTelegramVideo, callTelegram };
