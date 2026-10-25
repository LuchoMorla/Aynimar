'use strict';
/* eslint-disable no-console */

/**
 * Encargos del dueño al CTO (Claude) o al CEO (Codex) desde el bot de Telegram.
 * Mismo puente que Pescafast, con el bot y las variables actuales (sin variables nuevas):
 *   cualquier texto del dueño es un encargo (al CTO; al CEO si empieza por «CEO»);
 *   «💬 Pedir al CTO / CEO» → el siguiente texto del dueño es el encargo (por defecto, CTO);
 *   «📋 Mis encargos»       → últimos 5 con su estado;
 *   /start · /menu · /encargo [texto] · /encargos · /cancelar.
 * Se guardan en telegram_ops_requests; el script local ops-ceo-cto/tools/encargos-aynimar.sh
 * los toma (nueva → en_curso) y los responde por este mismo bot (→ respondida).
 * Solo lo usa el admin (routes/aiRouter.js filtra chat y remitente; los botones van firmados,
 * acción 'en'). El texto de los encargos nunca va a los logs: solo id y destinatario.
 * Nunca lanza: los errores se avisan al dueño por el chat.
 */

const { models } = require('../libs/sequelize');
const { callTelegram } = require('../utils/telegramNotify');
const { signCallbackData } = require('../libs/telegramSecurity');

const PENDING_KEY = 'ops.encargo.pending'; // app_settings: {"to":"cto","at":<ms>} mientras se espera el texto
const PENDING_TTL_MS = 30 * 60 * 1000;
const TO = { cto: '🛠 CTO', ceo: '🧭 CEO' };
const STATUS = { nueva: '🆕 nueva', en_curso: '⏳ en curso', respondida: '✅ respondida' };
const MAX_BODY = 2000;

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const btn = (text, ref) => ({ text, callback_data: signCallbackData('en', ref) });
const keyboard = (rows) => {
  const kb = rows.map((r) => r.map(([text, ref]) => btn(text, ref)));
  return kb.flat().every((b) => b.callback_data) ? { reply_markup: { inline_keyboard: kb } } : {};
};
const MENU_ROWS = [[['💬 Pedir al CTO / CEO', 'new']], [['📋 Mis encargos', 'list']]];
const TO_ROWS = [[['🛠 Para: CTO', 'cto'], ['🧭 Para: CEO', 'ceo']]];

function send(chatId, text, rows = null) {
  return callTelegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(rows ? keyboard(rows) : {}) });
}

async function getPending() {
  const row = await models.AppSetting.findOne({ where: { key: PENDING_KEY } });
  try {
    const p = JSON.parse(row?.value || 'null');
    return p && TO[p.to] && Date.now() - Number(p.at) < PENDING_TTL_MS ? p : null;
  } catch {
    return null;
  }
}

const setPending = (to) => models.AppSetting.upsert({ key: PENDING_KEY, value: to ? JSON.stringify({ to, at: Date.now() }) : null, updatedAt: new Date() });

function sendMenu(chatId) {
  return send(chatId, '🤖 <b>Aynimar · menú del dueño</b>\n' +
    '💬 <b>Pedir al CTO / CEO</b>: escribe lo que necesitas y te responden por aquí.\n' +
    '📋 <b>Mis encargos</b>: los últimos 5 y su estado.\n\n' +
    'Comandos: /encargo · /encargos · /cancelar · /estado · /stop · /reanudar', MENU_ROWS);
}

async function startRequest(chatId, to = 'cto') {
  await setPending(to);
  return send(chatId, `💬 ¿Qué necesitas? Escríbelo en tu próximo mensaje y se lo paso al equipo.\nPara: <b>${TO[to]}</b> (toca para cambiar). /cancelar para salir.`, TO_ROWS);
}

async function listText() {
  const rows = await models.TelegramOpsRequest.findAll({ order: [['id', 'DESC']], limit: 5 });
  if (!rows.length) return '📋 Aún no tienes encargos. Toca «💬 Pedir al CTO / CEO».';
  const line = (r) => {
    const body = String(r.body || '');
    return `#${r.id} · ${TO[r.recipient] || r.recipient} · ${STATUS[r.status] || r.status}\n    ${esc(body.slice(0, 80))}${body.length > 80 ? '…' : ''}`;
  };
  return ['📋 <b>Mis encargos (últimos 5)</b>', ...rows.map(line)].join('\n');
}

async function sendList(chatId) {
  return send(chatId, await listText(), MENU_ROWS);
}

/**
 * Guarda el encargo. request_id = tg-<chat>-<message_id>: si Telegram reintenta el mismo
 * update, findOrCreate devuelve la fila existente y no se duplica.
 */
async function saveRequest(msg, to, body) {
  const [row, created] = await models.TelegramOpsRequest.findOrCreate({
    where: { requestId: `tg-${msg.chat.id}-${msg.message_id}` },
    defaults: { recipient: to, body, status: 'nueva' },
  });
  await setPending(null);
  if (created) console.log(`[Encargos] #${row.id} recibido para ${row.recipient}.`);
  return send(msg.chat.id, `📨 Recibido (#${row.id}). El ${TO[row.recipient] || 'equipo'} lo atiende y te responde por aquí.`, MENU_ROWS);
}

async function safe(chatId, label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[Encargos] ${label} falló: ${err.name}`);
    await send(chatId, '⚠️ No se pudo completar. Inténtalo de nuevo en un momento.');
    return null;
  }
}

/** Comandos /start /menu /encargo /encargos /cancelar del admin. true si lo manejó. */
async function handleCommand(msg, text) {
  const m = /^\/(start|menu|encargo|encargos|cancelar)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = String(m[2] || '').trim().slice(0, MAX_BODY);
  const chatId = msg.chat.id;
  await safe(chatId, `/${cmd}`, async () => {
    if (cmd === 'start' || cmd === 'menu') return sendMenu(chatId);
    if (cmd === 'encargos') return sendList(chatId);
    if (cmd === 'cancelar') {
      const had = await getPending();
      await setPending(null);
      return send(chatId, had ? 'Cancelado. No se guardó ningún encargo.' : 'No había nada en curso.', MENU_ROWS);
    }
    // /encargo texto → encargo directo al CTO; /encargo solo → pide el texto.
    return arg.length >= 3 ? saveRequest(msg, 'cto', arg) : startRequest(chatId, 'cto');
  });
  return true;
}

/**
 * Mensaje del admin mientras se espera un encargo. true si lo consumió.
 * Un texto de solo 6 dígitos (2FA de Dropi) o un comando nunca es encargo.
 */
async function handleText(msg, text) {
  if (/^\d{6}$/.test(text) || text.startsWith('/')) return false;
  let pending;
  try {
    pending = await getPending();
  } catch (err) {
    console.error(`[Encargos] no se pudo leer el estado: ${err.name}`);
    return false;
  }
  if (!pending) {
    // Escribir directamente al bot también es un encargo (Luis, 25-oct): al CTO, o al CEO si empieza por «CEO».
    // Un texto con un código de 6 dígitos sigue yendo al 2FA de Dropi; notas de voz o fotos sueltas se ignoran.
    if (text.length < 3 || /\b\d{6}\b/.test(text)) return false;
    pending = { to: /^ceo\b/i.test(text) ? 'ceo' : 'cto' };
  }
  const chatId = msg.chat.id;
  if (!text) {
    // Notas de voz, fotos, etc.: el bot todavía no las transcribe.
    await send(chatId, 'Por ahora solo leo texto: escríbelo (mínimo 3 letras) o /cancelar.', TO_ROWS);
    return true;
  }
  const body = text.slice(0, MAX_BODY);
  if (body.length < 3) {
    await send(chatId, 'Escríbelo en texto (mínimo 3 letras) o /cancelar.', TO_ROWS);
    return true;
  }
  await safe(chatId, 'guardar encargo', () => saveRequest(msg, pending.to, body));
  return true;
}

/** Botón firmado (acción 'en') ya verificado como del admin. Nunca lanza. */
async function handleCallback(cq, ref) {
  const answer = (text) => callTelegram('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) });
  const chatId = cq.message?.chat?.id ?? cq.from?.id;
  if (!['new', 'cto', 'ceo', 'list'].includes(ref)) { await answer('Opción no encontrada.'); return; }
  await answer(ref === 'cto' || ref === 'ceo' ? `Para: ${TO[ref]}` : null);
  await safe(chatId, `botón ${ref}`, () => (ref === 'list' ? sendList(chatId) : startRequest(chatId, ref === 'new' ? 'cto' : ref)));
}

module.exports = { handleCommand, handleText, handleCallback, sendMenu, listText, PENDING_KEY, PENDING_TTL_MS };
