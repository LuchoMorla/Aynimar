'use strict';
/* eslint-disable no-console */
/**
 * Buzón del CTO — pruebas (sin BD ni red, mismo enfoque que telegram-approvals-test).
 * AppSetting y CreativeReview en memoria; global.fetch intercepta api.telegram.org;
 * 2FA de Dropi stub. Levanta el router real.
 *
 * Usage: node scripts/cto-inbox-test.js
 */

const path = require('path');
const crypto = require('crypto');

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

const twoFA = [];
const dropiAuthPath = require.resolve(path.join(__dirname, '../integrations/dropi/dropiAuthService'));
require.cache[dropiAuthPath] = { id: dropiAuthPath, filename: dropiAuthPath, loaded: true, exports: { completeManual2FA: async (c) => { twoFA.push(c); } } };

const { models } = require('../libs/sequelize');
const settings = new Map();
const store = new Map();
let dbDown = false;
models.AppSetting.findOne = async ({ where }) => { if (dbDown) throw Object.assign(new Error('db'), { name: 'SequelizeConnectionError' }); return settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null; };
models.AppSetting.upsert = async ({ key, value }) => { settings.set(key, value); return [{}]; };
const CR = models.CreativeReview;
CR.update = async (vals, { where }) => { const r = store.get(where.ref); if (!r || r.status !== where.status) return [0]; Object.assign(r, vals); return [1]; };
CR.findByPk = async (ref) => (store.has(ref) ? { ...store.get(ref) } : null);

const sec = require('../libs/telegramSecurity');
const inboxSvc = require('../Services/ctoInboxService');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = () => JSON.parse(settings.get('cto.inbox') || '[]');

async function main() {
  out('\n▶ Firma de la acción cq');
  const data = sec.signCallbackData('cq', 'abc123_1');
  assert('cq firmable con ref "<qid>_<n>" y ≤ 64 bytes', data && data.startsWith('mk:cq:abc123_1:') && Buffer.byteLength(data) <= 64);
  const longest = sec.signCallbackData('cq', 'abcdef123456_19');
  assert('qid de 12 + índice de 2 cifras sigue ≤ 64 bytes', longest && Buffer.byteLength(longest) <= 64);
  const ADMIN = Number(FAKE.ADMIN_ID);
  const cqOf = (cbData, { from = ADMIN, text = '❓ Pregunta CTO-abc123\n\n¿Color?\n\nOtra: responde', buttons } = {}) => ({
    id: 'cq1', from: { id: from }, data: cbData,
    message: { message_id: 77, chat: { id: ADMIN }, text, reply_markup: { inline_keyboard: buttons || [[{ text: 'Rojo', callback_data: sec.signCallbackData('cq', 'abc123_0') }], [{ text: 'Azul', callback_data: data }]] } },
  });
  assert('verifyCallbackQuery acepta cq firmado del admin', sec.verifyCallbackQuery(cqOf(data)).ok && sec.verifyCallbackQuery(cqOf(data)).action === 'cq');
  assert('verifyCallbackQuery rechaza cq de otro usuario', sec.verifyCallbackQuery(cqOf(data, { from: 5555 })).reason === 'unauthorized_user');
  assert('verifyCallbackQuery rechaza firma alterada', !sec.verifyCallbackQuery(cqOf(data.replace('abc123_1', 'abc123_0'))).ok);

  out('\n▶ Clave X-CTO-Key');
  const KEY = crypto.createHmac('sha256', FAKE.SECRET).update('aynimar-cto-inbox-v1').digest('hex');
  assert('ctoInboxKey = HMAC-SHA256(secreto, aynimar-cto-inbox-v1) hex', sec.ctoInboxKey() === KEY);
  assert('sin secreto → null', sec.ctoInboxKey({}) === null && !sec.isValidCtoKey(KEY, {}));
  assert('questionId ignora mensajes con "Ref:"', inboxSvc.questionId('Pregunta CTO-abc') === 'abc' && inboxSvc.questionId('Ref: v1 Pregunta CTO-abc') === null);

  const express = require('express');
  require('../utils/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', require('../routes/aiRouter'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ai`;
  const post = async (update) => { const r = await realFetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': FAKE.SECRET }, body: JSON.stringify(update) }); await r.text(); await sleep(80); };
  const get = async (q = '', key = KEY) => { const r = await realFetch(`${base}/cto/inbox${q}`, { headers: key ? { 'X-CTO-Key': key } : {} }); return { status: r.status, body: await r.json() }; };
  const msg = (text, { from = ADMIN, reply } = {}) => ({ update_id: 2, message: { message_id: ++msgSeq, chat: { id: from }, from: { id: from }, text, ...(reply ? { reply_to_message: reply } : {}) } });
  const bot = (text) => ({ message_id: 77, from: { id: 111111, is_bot: true }, text });

  try {
    out('\n▶ Respuesta por botón');
    let n = tg.length;
    await post({ update_id: 1, callback_query: cqOf(data) });
    let calls = since(n);
    assert('guarda {qid, option, label, at, id}', inbox().length === 1 && inbox()[0].qid === 'abc123' && inbox()[0].option === 1 && inbox()[0].label === 'Azul' && inbox()[0].id === 1 && inbox()[0].at);
    assert('answerCallbackQuery "Respuesta: Azul"', calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'Respuesta: Azul'));
    const ed = calls.find((c) => c.method === 'editMessageText');
    assert('edita el texto con "Respuesta: Azul" y quita botones', ed && ed.body.text.endsWith('Respuesta: Azul') && ed.body.reply_markup.inline_keyboard.length === 0);
    n = tg.length;
    await post({ update_id: 1, callback_query: cqOf(data, { from: 5555 }) });
    assert('cq de otro usuario → rechazado, no guarda', inbox().length === 1 && since(n).some((c) => c.body.text === '⛔ Acción no válida.'));

    out('\n▶ Respuesta por texto (Responder)');
    n = tg.length;
    let fa = twoFA.length;
    await post(msg('Prefiero verde, con código 123456 del cupón', { reply: bot('❓ Pregunta CTO-abc123\n\n¿Color?') }));
    assert('guarda {qid, text} con id incremental', inbox().length === 2 && inbox()[1].qid === 'abc123' && inbox()[1].text === 'Prefiero verde, con código 123456 del cupón' && inbox()[1].id === 2);
    assert('confirma "📝 Recibido por el CTO" y no dispara 2FA', since(n).some((c) => c.method === 'sendMessage' && c.body.text === '📝 Recibido por el CTO') && twoFA.length === fa);
    await post(msg('otra cosa', { from: 5555, reply: bot('❓ Pregunta CTO-abc123') }));
    assert('respuesta de otro chat → ignorada', inbox().length === 2);

    out('\n▶ 2FA y cambios intactos');
    await post(msg('654321', { reply: bot('❓ Pregunta CTO-abc123') }));
    assert('6 dígitos sueltos en respuesta a pregunta → 2FA, no buzón', twoFA.at(-1) === '654321' && inbox().length === 2);
    await post(msg('código 111222'));
    assert('6 dígitos sin reply → 2FA', twoFA.at(-1) === '111222');
    store.set('v82xch', { ref: 'v82xch', status: 'changes_requested' });
    CR.update = async (vals, { where }) => { const r = store.get(where.ref); if (!r || (where.status && r.status !== where.status)) return [0]; Object.assign(r, vals); return [1]; };
    n = tg.length;
    await post(msg('fondo blanco', { reply: bot('✏️ Ref: v82xch\nResponde (Responder)') }));
    assert('"Ref:" sigue yendo a cambios, no al buzón', store.get('v82xch').changeRequest === 'fondo blanco' && inbox().length === 2 && since(n).some((c) => c.body.text?.includes('Cambios guardados')));

    out('\n▶ Callbacks ap/rj/ch siguen yendo a revisiones');
    store.set('v82xap', { ref: 'v82xap', status: 'pending', productId: 82, caption: 'c', utmLink: 'u' });
    await post({ update_id: 3, callback_query: { id: 'c2', from: { id: ADMIN }, data: sec.signCallbackData('rj', 'v82xap'), message: { message_id: 555, chat: { id: ADMIN }, caption: 'Ref: v82xap' } } });
    assert('rj firmado → pieza rejected, buzón intacto', store.get('v82xap').status === 'rejected' && inbox().length === 2);

    out('\n▶ Endpoint GET /cto/inbox');
    let r = await get('?after=1');
    assert('200 con clave válida y solo id > after', r.status === 200 && r.body.entries.length === 1 && r.body.entries[0].id === 2);
    r = await get('');
    assert('sin after → todas', r.status === 200 && r.body.entries.length === 2);
    assert('403 sin clave o clave inválida', (await get('', null)).status === 403 && (await get('', KEY.slice(0, -1) + '0')).status === 403);
    assert('400 con after inválido', (await get('?after=-1')).status === 400 && (await get('?after=x')).status === 400);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    assert('503 sin TELEGRAM_WEBHOOK_SECRET', (await get('')).status === 503);
    process.env.TELEGRAM_WEBHOOK_SECRET = FAKE.SECRET;
    dbDown = true;
    assert('500 si la BD falla', (await get('')).status === 500);
    dbDown = false;

    out('\n▶ scripts/cto-ask.js inbox (contra este servidor)');
    const run = (args, env) => new Promise((r) => require('child_process').execFile(process.execPath, [path.join(__dirname, 'cto-ask.js'), ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => r({ code: err ? err.code : 0, stdout, stderr })));
    const ci = await run(['inbox', '1'], { BACKEND_URL: base.replace('/api/v1/ai', '') });
    assert('inbox imprime las entradas con id > after', ci.code === 0 && JSON.parse(ci.stdout).length === 1 && JSON.parse(ci.stdout)[0].id === 2, ci.stderr);
    assert('salida del script sin secreto ni clave', ![FAKE.SECRET, KEY, FAKE.BOT_TOKEN].some((x) => (ci.stdout + ci.stderr).includes(x)));
    const prod = await run(['ask', 'hola'], { RAILWAY_ENVIRONMENT_NAME: 'production' });
    assert('se niega a correr en production', prod.code === 1 && prod.stderr.includes('solo se usa contra staging'));

    out('\n▶ Tope de 100');
    for (let i = 0; i < 105; i++) await inboxSvc.add({ qid: 'q', text: `t${i}` });
    const all = inbox();
    assert('máximo 100 entradas, descarta las viejas, ids siguen creciendo', all.length === 100 && all[0].id === 8 && all.at(-1).id === 107);
  } finally {
    server.close();
  }

  out('\n▶ Logs');
  const all = logs.join('\n');
  assert('logs sin token, secreto, clave ni contenido de respuestas', ![FAKE.BOT_TOKEN, FAKE.SECRET, KEY, 'Prefiero verde', 'Azul', '654321'].some((x) => all.includes(x)));

  out(`\n${'─'.repeat(50)}\nCTO inbox tests: ${passed} passed, ${failed} failed\n`);
  if (failed) { console._error('Logs capturados:\n' + all); process.exit(1); }
  process.exit(0);
}

main().catch((err) => { console._error('Error inesperado en la suite:', err); process.exit(1); });
