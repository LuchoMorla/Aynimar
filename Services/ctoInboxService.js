'use strict';
/* eslint-disable no-console */

/**
 * Buzón del CTO: respuestas del propietario a preguntas enviadas por el bot
 * (scripts/cto-ask.js). Se guardan en app_settings clave 'cto.inbox' como
 * array JSON (máx. MAX_ENTRIES, se descartan las más viejas) y se leen con
 * GET /api/v1/ai/cto/inbox. Ver docs/TELEGRAM_SECURITY.md.
 */

const { models } = require('../libs/sequelize');
const { callTelegram } = require('../utils/telegramNotify');

const INBOX_KEY = 'cto.inbox';
const MAX_ENTRIES = 100;
const QUESTION_RE = /Pregunta CTO-([A-Za-z0-9]{1,12})\b/;
const OPTION_REF_RE = /^([A-Za-z0-9]{1,12})_(\d{1,2})$/;

/** qid de un mensaje del bot con "Pregunta CTO-<qid>" (nunca si es de una pieza con "Ref:"). */
function questionId(text) {
  const t = String(text || '');
  if (/Ref: /.test(t)) return null;
  return QUESTION_RE.exec(t)?.[1] || null;
}

async function read() {
  const row = await models.AppSetting.findOne({ where: { key: INBOX_KEY } });
  try {
    const list = JSON.parse(row?.value || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// ponytail: read-modify-write sin bloqueo; una respuesta simultánea podría
// perderse. Basta para un solo admin; usar SELECT ... FOR UPDATE si crece.
async function add(entry) {
  const list = await read();
  const id = (list.at(-1)?.id || 0) + 1;
  list.push({ id, ...entry, at: new Date().toISOString() });
  const kept = list.slice(-MAX_ENTRIES);
  await models.AppSetting.upsert({ key: INBOX_KEY, value: JSON.stringify(kept), updatedAt: new Date() });
  return id;
}

async function listAfter(after = 0) {
  return (await read()).filter((e) => e.id > after);
}

/** Botón de opción ya verificado (acción 'cq'). Nunca lanza; no registra el contenido. */
async function handleCallback(cq, ref) {
  const answer = (text) => callTelegram('answerCallbackQuery', { callback_query_id: cq.id, text });
  const m = OPTION_REF_RE.exec(ref);
  const label = (cq.message?.reply_markup?.inline_keyboard || []).flat().find((b) => b.callback_data === cq.data)?.text;
  if (!m || !label) { await answer('Opción no encontrada.'); return; }
  try {
    await add({ qid: m[1], option: Number(m[2]), label });
  } catch (err) {
    console.error(`[CTO] no se pudo guardar la respuesta de ${m[1]}: ${err.name}`);
    await answer('⚠️ No se pudo guardar. Inténtalo de nuevo.');
    return;
  }
  console.log(`[CTO] respuesta (botón) guardada para ${m[1]}.`);
  await answer(`Respuesta: ${label}`);
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  if (!chatId || !messageId) return;
  const text = `${String(cq.message.text || '').slice(0, 3900)}\n\nRespuesta: ${label}`;
  const edited = await callTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } });
  if (!edited) await callTelegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

/** Respuesta de texto libre (Responder) a una pregunta. Nunca lanza; no registra el contenido. */
async function handleReply(msg, qid, text) {
  const reply = (t) => callTelegram('sendMessage', { chat_id: msg.chat.id, text: t, reply_to_message_id: msg.message_id });
  try {
    await add({ qid, text });
  } catch (err) {
    console.error(`[CTO] no se pudo guardar la respuesta de ${qid}: ${err.name}`);
    await reply('⚠️ No se pudo guardar tu respuesta. Inténtalo de nuevo.');
    return;
  }
  console.log(`[CTO] respuesta (texto) guardada para ${qid}.`);
  await reply('📝 Recibido por el CTO');
}

module.exports = { questionId, add, listAfter, handleCallback, handleReply, OPTION_REF_RE, INBOX_KEY, MAX_ENTRIES };
