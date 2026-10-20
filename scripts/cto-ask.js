'use strict';
/* eslint-disable no-console */
/**
 * Preguntas del CTO al propietario por el bot de Telegram de STAGING.
 *
 *   railway run -e staging -s Aynimar-staging -- node scripts/cto-ask.js ask "¿Pregunta?" ["Opción 1" "Opción 2" ...]
 *   railway run -e staging -s Aynimar-staging -- node scripts/cto-ask.js inbox [after]
 *
 * ask   → envía la pregunta al admin con botones firmados (acción 'cq') e imprime el qid.
 *         El propietario puede pulsar un botón o responder (Responder) con texto libre.
 * inbox → GET <BACKEND_URL | https://RAILWAY_PUBLIC_DOMAIN>/api/v1/ai/cto/inbox?after=N
 *         con X-CTO-Key derivada de TELEGRAM_WEBHOOK_SECRET; imprime las respuestas (JSON).
 *
 * Variables (las inyecta railway run): TELEGRAM_BOT_TOKEN, TELEGRAM_NONPROD_BOT_ID,
 * TELEGRAM_CHAT_ID/TELEGRAM_OWNER_ID, TELEGRAM_WEBHOOK_SECRET, RAILWAY_PUBLIC_DOMAIN.
 * Nunca imprime token, secreto ni clave. Se niega a ejecutarse en production.
 */

const crypto = require('crypto');
const { getAdminChatId, signCallbackData, isProductionEnv, telegramDisabledReason, ctoInboxKey } = require('../libs/telegramSecurity');
const { callTelegram } = require('../utils/telegramNotify');

const die = (m) => { console.error(m); process.exit(1); };

async function ask(question, options) {
  if (!question) die('Uso: cto-ask.js ask "<pregunta>" ["opción 1" ...]');
  if (options.length > 20) die('Máximo 20 opciones.');
  const reason = telegramDisabledReason();
  if (reason) die(`Telegram no disponible: ${reason}`);
  if (!getAdminChatId()) die('Admin no configurado (TELEGRAM_OWNER_ID / TELEGRAM_CHAT_ID).');
  const qid = crypto.randomBytes(6).toString('hex');
  const buttons = options.map((text, i) => [{ text: String(text).slice(0, 64), callback_data: signCallbackData('cq', `${qid}_${i}`) }]);
  if (buttons.some(([b]) => !b.callback_data)) die('No se pudieron firmar los botones (¿TELEGRAM_WEBHOOK_SECRET?).');
  const text = `❓ Pregunta CTO-${qid}\n\n${question}\n\nOtra: responde (Responder) a este mensaje con tu texto`;
  const sent = await callTelegram('sendMessage', {
    chat_id: getAdminChatId(),
    text,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  if (!sent) die('Telegram rechazó el envío.');
  console.log(qid);
}

async function inbox(after) {
  const key = ctoInboxKey();
  if (!key) die('TELEGRAM_WEBHOOK_SECRET no configurado.');
  const base = process.env.BACKEND_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  if (!base) die('Sin URL: define BACKEND_URL o RAILWAY_PUBLIC_DOMAIN.');
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/ai/cto/inbox?after=${encodeURIComponent(after || 0)}`, {
    headers: { 'X-CTO-Key': key },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) die(`El endpoint respondió ${res.status}.`);
  const data = await res.json();
  console.log(JSON.stringify(data.entries, null, 2));
}

async function main() {
  if (isProductionEnv()) die('cto-ask.js solo se usa contra staging.');
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'ask') return ask(args[0], args.slice(1));
  if (cmd === 'inbox') return inbox(args[0]);
  die('Uso: cto-ask.js ask "<pregunta>" ["opción" ...] | cto-ask.js inbox [after]');
}

main().catch((err) => die(`Error: ${err.name}`));
