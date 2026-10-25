'use strict';
/* eslint-disable no-console */
/**
 * Encargos al CTO/CEO desde el bot — pruebas (sin BD ni red, mismo enfoque que cto-inbox-test).
 * AppSetting, TelegramOpsRequest y CreativeReview en memoria; global.fetch intercepta
 * api.telegram.org; 2FA de Dropi stub. Levanta el router real.
 *
 * Usage: node scripts/telegram-ops-requests-test.js
 */

const path = require('path');

const FAKE = { BOT_TOKEN: '111111:FAKE-bot-token-for-tests-only', SECRET: 'test_webhook-SECRET_abc123', ADMIN_ID: '987654321' };
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k.startsWith('RAILWAY_') || k === 'REDIS_URL' || k === 'STORE_BASE_URL') delete process.env[k];
Object.assign(process.env, {
  DATABASE_URL: 'postgres://tgtest:test@localhost:5432/tgtest_never_connects',
  JWT_SECRET: 'test-jwt-secret-only',
  TELEGRAM_BOT_TOKEN: FAKE.BOT_TOKEN,
  TELEGRAM_CHAT_ID: FAKE.ADMIN_ID,
  TELEGRAM_WEBHOOK_SECRET: FAKE.SECRET,
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  TELEGRAM_NONPROD_BOT_ID: '111111',
});

const logs = [];
for (const level of ['log', 'warn', 'error', 'info']) { console[`_${level}`] = console[level]; console[level] = (...a) => logs.push(a.map(String).join(' ')); }
const out = (...a) => console._log(...a);
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { out(`  ✅ ${label}`); passed++; } else { console._error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const realFetch = global.fetch;
const tg = [];
let msgSeq = 1000;
global.fetch = async (url, opts = {}) => {
  const s = String(url);
  if (!s.startsWith('https://api.telegram.org/')) return realFetch(url, opts);
  tg.push({ method: s.split('/').pop(), body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({ ok: true, result: s.endsWith('sendMessage') ? { message_id: ++msgSeq } : true }) };
};
const since = (n) => tg.slice(n);
const sent = (n) => since(n).filter((c) => c.method === 'sendMessage');

const twoFA = [];
const dropiAuthPath = require.resolve(path.join(__dirname, '../integrations/dropi/dropiAuthService'));
require.cache[dropiAuthPath] = { id: dropiAuthPath, filename: dropiAuthPath, loaded: true, exports: { completeManual2FA: async (c) => { twoFA.push(c); } } };

const { models } = require('../libs/sequelize');
const settings = new Map();
let dbDown = false;
const down = () => { if (dbDown) throw Object.assign(new Error('db'), { name: 'SequelizeConnectionError' }); };
models.AppSetting.findOne = async ({ where }) => { down(); return settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null; };
models.AppSetting.upsert = async ({ key, value }) => { down(); settings.set(key, value); return [{}]; };
const rows = [];
models.TelegramOpsRequest.findOrCreate = async ({ where, defaults }) => {
  down();
  const found = rows.find((r) => r.requestId === where.requestId);
  if (found) return [found, false];
  const row = { id: rows.length + 1, requestId: where.requestId, ...defaults, createdAt: new Date() };
  rows.push(row);
  return [row, true];
};
models.TelegramOpsRequest.findAll = async ({ limit }) => { down(); return [...rows].sort((a, b) => b.id - a.id).slice(0, limit); };
const store = new Map();
models.CreativeReview.update = async (vals, { where }) => { const r = store.get(where.ref); if (!r || (where.status && r.status !== where.status)) return [0]; Object.assign(r, vals); return [1]; };
models.CreativeReview.findByPk = async (ref) => (store.has(ref) ? { ...store.get(ref) } : null);

const sec = require('../libs/telegramSecurity');
const svc = require('../Services/telegramOpsRequestService');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = () => JSON.parse(settings.get(svc.PENDING_KEY) || 'null');
const inbox = () => JSON.parse(settings.get('cto.inbox') || '[]');
const cbData = (b) => b.callback_data;
const buttonsOf = (call) => (call?.body.reply_markup?.inline_keyboard || []).flat();

async function main() {
  const ADMIN = Number(FAKE.ADMIN_ID);
  const OTHER = 5555;

  out('\n▶ Firma de la acción en');
  for (const ref of ['new', 'cto', 'ceo', 'list']) {
    const d = sec.signCallbackData('en', ref);
    assert(`en:${ref} firmable y ≤ 64 bytes`, d && d.startsWith(`mk:en:${ref}:`) && Buffer.byteLength(d) <= 64);
  }
  const cq = (ref, { from = ADMIN, data } = {}) => ({ id: `cq-${ref}`, from: { id: from }, data: data || sec.signCallbackData('en', ref), message: { message_id: 77, chat: { id: from }, text: 'menú' } });
  assert('verifyCallbackQuery acepta en del admin y rechaza a otro', sec.verifyCallbackQuery(cq('new')).action === 'en' && sec.verifyCallbackQuery(cq('new', { from: OTHER })).reason === 'unauthorized_user');

  const express = require('express');
  require('../utils/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', require('../routes/aiRouter'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ai`;
  const post = async (update) => { const r = await realFetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': FAKE.SECRET }, body: JSON.stringify(update) }); await r.text(); await sleep(80); };
  const msg = (text, { from = ADMIN, chat = from, id = ++msgSeq, reply, extra } = {}) => ({ update_id: id, message: { message_id: id, chat: { id: chat }, from: { id: from }, ...(text == null ? {} : { text }), ...(reply ? { reply_to_message: reply } : {}), ...extra } });
  const bot = (text) => ({ message_id: 77, from: { id: 111111, is_bot: true }, text });

  try {
    out('\n▶ Menú (/start) solo para el dueño');
    let n = tg.length;
    await post(msg('/start'));
    let s = sent(n);
    const menuBtns = buttonsOf(s[0]);
    assert('/start → menú con «💬 Pedir al CTO / CEO» y «📋 Mis encargos» firmados', s.length === 1 && menuBtns.map((b) => b.text).join('|') === '💬 Pedir al CTO / CEO|📋 Mis encargos'
      && cbData(menuBtns[0]) === sec.signCallbackData('en', 'new') && cbData(menuBtns[1]) === sec.signCallbackData('en', 'list'), JSON.stringify(s[0]?.body));
    n = tg.length;
    await post(msg('/menu'));
    assert('/menu → mismo menú', buttonsOf(sent(n)[0]).length === 2);
    n = tg.length;
    await post(msg('/start', { from: OTHER }));
    await post(msg('/encargo hazme algo', { from: OTHER }));
    await post(msg('/encargo hazme algo', { from: OTHER, chat: ADMIN })); // remitente ajeno en el chat del dueño
    assert('no dueño: no ve menú ni crea encargos', since(n).length === 0 && rows.length === 0);
    n = tg.length;
    await post({ update_id: 5, callback_query: cq('new', { from: OTHER }) });
    assert('botón de un no dueño → rechazado, sin estado', since(n).some((c) => c.body.text === '⛔ Acción no válida.') && pending() === null);

    out('\n▶ «💬 Pedir al CTO / CEO» → texto → encargo');
    n = tg.length;
    await post({ update_id: 6, callback_query: cq('new') });
    s = sent(n);
    assert('pide el texto, por defecto CTO, con 🛠/🧭 elegibles', pending()?.to === 'cto' && /Para: <b>🛠 CTO<\/b>/.test(s[0]?.body.text) && buttonsOf(s[0]).map(cbData).join() === [sec.signCallbackData('en', 'cto'), sec.signCallbackData('en', 'ceo')].join());
    await post({ update_id: 7, callback_query: cq('ceo') });
    assert('elige CEO', pending()?.to === 'ceo');
    n = tg.length;
    const fa = twoFA.length;
    await post(msg('Revisa el margen <b>del</b> producto 98 ENCARGO-CENTINELA-91'));
    s = sent(n);
    assert('guarda el encargo para CEO como nueva', rows.length === 1 && rows[0].recipient === 'ceo' && rows[0].status === 'nueva' && rows[0].body.includes('ENCARGO-CENTINELA-91') && /^tg-987654321-\d+$/.test(rows[0].requestId));
    assert('responde «📨 Recibido (#1)…» y limpia el estado', /^📨 Recibido \(#1\)/.test(s[0]?.body.text) && pending() === null && twoFA.length === fa);

    out('\n▶ Idempotencia (reintento del mismo update)');
    await post({ update_id: 8, callback_query: cq('new') });
    const dup = msg('Sube 3 productos nuevos', { id: 4242 });
    await post(dup);
    settings.set(svc.PENDING_KEY, JSON.stringify({ to: 'cto', at: Date.now() })); // reintento con estado aún vivo
    n = tg.length;
    await post(dup);
    assert('mismo message_id → mismo #id, sin duplicar', rows.length === 2 && /^📨 Recibido \(#2\)/.test(sent(n)[0]?.body.text));
    await post(msg('/cancelar'));

    out('\n▶ 2FA, notas de voz y comandos con encargo pendiente');
    await post({ update_id: 9, callback_query: cq('new') });
    await post(msg('654321'));
    assert('6 dígitos solos → 2FA, no encargo; el estado sigue', twoFA.at(-1) === '654321' && rows.length === 2 && pending()?.to === 'cto');
    n = tg.length;
    await post(msg(null, { extra: { voice: { file_id: 'x', duration: 3 } } }));
    assert('nota de voz → pide texto, no guarda', rows.length === 2 && /solo leo texto/.test(sent(n)[0]?.body.text));
    await post(msg('ok'));
    assert('texto < 3 letras → no guarda', rows.length === 2);
    await post(msg('Prefiero verde', { reply: bot('❓ Pregunta CTO-abc123\n\n¿Color?') }));
    assert('respuesta a una pregunta del CTO sigue yendo al buzón', inbox().length === 1 && rows.length === 2);
    store.set('v82xch', { ref: 'v82xch', status: 'changes_requested' });
    await post(msg('fondo blanco', { reply: bot('✏️ Ref: v82xch\nResponde (Responder)') }));
    assert('respuesta con "Ref:" sigue yendo a cambios de la pieza', store.get('v82xch').changeRequest === 'fondo blanco' && rows.length === 2);
    n = tg.length;
    await post(msg('/cancelar'));
    assert('/cancelar → limpia y no guarda', pending() === null && /Cancelado/.test(sent(n)[0]?.body.text) && rows.length === 2);
    n = tg.length;
    await post(msg('texto suelto sin encargo pendiente'));
    assert('sin encargo pendiente, el texto directo es encargo al CTO', rows.length === 3 && rows[2].recipient === 'cto' && /^📨 Recibido \(#3\)/.test(sent(n)[0]?.body.text));
    await post(msg('CEO: revisa el margen del 100'));
    assert('texto directo que empieza por «CEO» → encargo al CEO', rows.length === 4 && rows[3].recipient === 'ceo');
    await post(msg('código 111222'));
    assert('2FA sin encargo pendiente intacto (no es encargo)', twoFA.at(-1) === '111222' && rows.length === 4);
    await post(msg('ok'));
    assert('texto < 3 letras sin pendiente → se ignora', rows.length === 4);
    settings.set(svc.PENDING_KEY, JSON.stringify({ to: 'ceo', at: Date.now() - svc.PENDING_TTL_MS - 1 }));
    await post(msg('esto llega tarde'));
    assert('estado caducado (> 30 min) → va como encargo directo al CTO', rows.length === 5 && rows[4].recipient === 'cto');
    rows.splice(2); // las pruebas siguientes cuentan desde #3

    out('\n▶ /encargo y /encargos');
    n = tg.length;
    await post(msg('/encargo Prepara el informe semanal'));
    assert('/encargo texto → encargo directo al CTO', rows.length === 3 && rows[2].recipient === 'cto' && /^📨 Recibido \(#3\)/.test(sent(n)[0]?.body.text));
    await post(msg('/encargo'));
    assert('/encargo solo → pide el texto', pending()?.to === 'cto');
    await post(msg('/cancelar'));
    rows[0].status = 'respondida';
    rows[1].status = 'en_curso';
    for (let i = 0; i < 3; i++) rows.push({ id: rows.length + 1, requestId: `x${i}`, recipient: 'cto', body: `relleno ${i}`, status: 'nueva' });
    n = tg.length;
    await post(msg('/encargos'));
    let t = sent(n)[0]?.body.text || '';
    assert('/encargos → últimos 5, más nuevo primero', /Mis encargos \(últimos 5\)/.test(t) && t.indexOf('#6') < t.indexOf('#2') && !t.includes('#1 ·'), t);
    assert('estado visible (⏳ en curso)', t.includes('#2 · 🛠 CTO · ⏳ en curso'));
    n = tg.length;
    await post({ update_id: 10, callback_query: cq('list') });
    rows.splice(5);
    rows.length = 1;
    await post(msg('/encargos'));
    t = sent(n).at(-1)?.body.text || '';
    assert('«📋 Mis encargos» escapa HTML del texto', t.includes('&lt;b&gt;del&lt;/b&gt;') && t.includes('✅ respondida'), t);

    out('\n▶ Errores de BD');
    dbDown = true;
    n = tg.length;
    await post(msg('/encargos'));
    assert('BD caída → aviso al dueño, sin caerse', /No se pudo completar/.test(sent(n)[0]?.body.text));
    dbDown = false;
    await post(msg('/start'));
    assert('el bot sigue respondiendo después', buttonsOf(tg.at(-1)).length === 2);
  } finally {
    server.close();
  }

  out('\n▶ Logs');
  const all = logs.join('\n');
  assert('logs sin token, secreto ni texto de encargos', ![FAKE.BOT_TOKEN, FAKE.SECRET, 'ENCARGO-CENTINELA-91', 'Prepara el informe', 'Sube 3 productos'].some((x) => all.includes(x)));
  assert('log registra solo id y destinatario', all.includes('[Encargos] #1 recibido para ceo.'));

  out(`\n${'─'.repeat(50)}\nTelegram encargos tests: ${passed} passed, ${failed} failed\n`);
  if (failed) { console._error('Logs capturados:\n' + all); process.exit(1); }
  process.exit(0);
}

main().catch((err) => { console._error('Error inesperado en la suite:', err); process.exit(1); });
