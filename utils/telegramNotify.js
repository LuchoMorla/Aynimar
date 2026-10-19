'use strict';

const { getTelegramToken } = require('../libs/telegramSecurity');

async function sendTelegramNotification(text) {
  const token  = getTelegramToken();
  const chatId = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

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

module.exports = { sendTelegramNotification };
