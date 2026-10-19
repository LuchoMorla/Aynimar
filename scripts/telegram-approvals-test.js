'use strict';
/* eslint-disable no-console */
/**
 * Telegram Approvals Test Suite — F2
 *
 * Sin BD: los métodos de los modelos CreativeReview y AppSetting se sustituyen
 * por un almacén en memoria que respeta el WHERE (ref + status) del UPDATE
 * atómico. Sin red: global.fetch intercepta api.telegram.org. El 2FA de Dropi
 * es un stub. Levanta el router real (routes/aiRouter.js) en un puerto local.
 *
 * Usage: node scripts/telegram-approvals-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = {
  BOT_TOKEN: '111111:FAKE-bot-token-for-tests-only',
  SECRET:    'test_webhook-SECRET_abc123',
  ADMIN_ID:  '987654321',
};
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k.startsWith('RAILWAY_') || k === 'REDIS_URL') delete process.env[k];
Object.assign(process.env, {
  DATABASE_URL:             'postgres://tgtest:test@localhost:5432/tgtest_never_connects',
  JWT_SECRET:               'test-jwt-secret-only',
  TELEGRAM_BOT_TOKEN:       FAKE.BOT_TOKEN,
  TELEGRAM_CHAT_ID:         FAKE.ADMIN_ID,
  TELEGRAM_WEBHOOK_SECRET:  FAKE.SECRET,
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  TELEGRAM_NONPROD_BOT_ID:  '111111',
});

const logs = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  console[`_${level}`] = console[level];
  console[level] = (...args) => logs.push(args.map(String).join(' '));
}
const out = (...a) => console._log(...a);
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { out(`  ✅ ${label}`); passed++; } else { console._error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── Telegram (fetch) ─────────────────────────────────────────────────────────
const realFetch = global.fetch;
const tg = [];
const tgFail = new Set(); // métodos que Telegram "rechaza"
let msgSeq = 1000;
global.fetch = async (url, opts = {}) => {
  const s = String(url);
  if (s.startsWith('https://api.telegram.org/')) {
    const method = s.split('/').pop();
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    tg.push({ method, body, form: typeof opts.body === 'string' ? null : opts.body });
    if (tgFail.has(method)) return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: stub' }) };
    const result = method === 'sendVideo' ? { message_id: 555, video: { file_id: 'FILEID-555' } }
      : method === 'sendMessage' ? { message_id: ++msgSeq } : true;
    return { ok: true, json: async () => ({ ok: true, result }) };
  }
  return realFetch(url, opts);
};
const since = (n) => tg.slice(n);

// ── Dropi 2FA (stub) ─────────────────────────────────────────────────────────
const twoFA = [];
const dropiAuthPath = require.resolve(path.join(__dirname, '../integrations/dropi/dropiAuthService'));
require.cache[dropiAuthPath] = { id: dropiAuthPath, filename: dropiAuthPath, loaded: true, exports: { completeManual2FA: async (c) => { twoFA.push(c); } } };

// ── Modelos en memoria ───────────────────────────────────────────────────────
const { models } = require('../libs/sequelize');
const store = new Map();
const settings = new Map();
let dbDown = false;
const updateCalls = [];
const CR = models.CreativeReview;
CR.create = async (v) => { if (dbDown) throw Object.assign(new Error('connect ECONNREFUSED postgres://user:pw@host'), { name: 'SequelizeConnectionError' }); store.set(v.ref, { ...v, createdAt: new Date(Date.now() + store.size) }); return v; };
CR.update = async (vals, { where }) => {
  updateCalls.push({ vals, where });
  if (dbDown) throw Object.assign(new Error('db down'), { name: 'SequelizeConnectionError' });
  const r = store.get(where.ref);
  if (!r || r.status !== where.status) return [0];
  Object.assign(r, vals);
  return [1];
};
CR.findByPk = async (ref) => (store.has(ref) ? { ...store.get(ref) } : null);
CR.findAll = async ({ limit }) => [...store.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
models.AppSetting.findOne = async ({ where }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null);
models.AppSetting.upsert = async ({ key, value }) => { settings.set(key, value); return [{}]; };

const sec = require('../libs/telegramSecurity');
const vs = require('../integrations/videoService');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1. Envío a revisión → fila pending ────────────────────────────────────
  out('\n▶ Envío a revisión (sendForReview) → fila pending');
  const tmp = path.join(os.tmpdir(), `apptest-${process.pid}.mp4`);
  fs.writeFileSync(tmp, Buffer.from('fake mp4'));
  const product = { id: 82, name: 'Fuente <b>Pro</b> & agua', price: 24.9 };
  const REF = vs.newRef(82);
  const sent = await vs.sendForReview({ file: tmp, product, variant: 'v1', benefit: 'Agua  fresca siempre', network: 'tiktok', ref: REF });
  const row = store.get(REF);
  assert('sendVideo devuelve file_id y message_id', sent.ok && sent.fileId === 'FILEID-555' && sent.messageId === 555);
  assert('fila pending con ref, producto, variante, red, file_id y message_id', row?.status === 'pending' && row.productId === 82 && row.variant === 'v1' && row.network === 'tiktok' && row.telegramFileId === 'FILEID-555' && row.telegramMessageId === 555);
  assert('link UTM guardado', row?.utmLink === vs.storeLink(82, { network: 'tiktok', campaign: 'video_v1', ref: REF }));
  assert('caption para la red con beneficio, precio y link', row?.caption.includes('Agua fresca siempre') && row.caption.includes('$24.90') && row.caption.includes(row.utmLink));
  dbDown = true;
  let n = tg.length;
  const REF_DB = vs.newRef(83);
  let threw = false;
  try { await vs.sendForReview({ file: tmp, product: { ...product, id: 83 }, variant: 'v2', benefit: 'Algo útil', network: 'instagram', ref: REF_DB }); } catch { threw = true; }
  dbDown = false;
  assert('BD caída al registrar → no lanza (el vídeo ya se envió)', !threw && since(n).some((c) => c.method === 'sendVideo'));
  assert('BD caída → aviso al admin', since(n).some((c) => c.method === 'sendMessage' && c.body.text.includes(REF_DB) && c.body.text.includes('no se pudo registrar')));
  assert('BD caída → log saneado (sin cadena de conexión)', logs.some((l) => l.includes(REF_DB) && l.includes('SequelizeConnectionError')) && !logs.join('\n').includes('user:pw'));
  fs.rmSync(tmp, { force: true });

  // ── 2. Router real ────────────────────────────────────────────────────────
  const express = require('express');
  require('../utils/auth');
  const aiRouter = require('../routes/aiRouter');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', aiRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ai`;
  async function post(update) {
    const r = await realFetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': FAKE.SECRET }, body: JSON.stringify(update) });
    await r.text();
    await sleep(80);
    return r.status;
  }
  const ADMIN = Number(FAKE.ADMIN_ID);
  const reviewCaption = (ref) => `Vídeo V1 para revisión\nFuente · $24.90\nRef: ${ref}\nhttps://www.aynimar.com/store/82`;
  const cq = (action, ref, { data, from = ADMIN, messageId = 555 } = {}) => ({
    update_id: 1,
    callback_query: { id: `cq-${action}-${ref}`, from: { id: from }, message: { message_id: messageId, chat: { id: ADMIN }, caption: reviewCaption(ref) }, data: data ?? sec.signCallbackData(action, ref) },
  });
  const msg = (text, { from = ADMIN, chat = ADMIN, reply } = {}) => ({ update_id: 2, message: { message_id: ++msgSeq, chat: { id: chat }, from: { id: from }, text, ...(reply ? { reply_to_message: reply } : {}) } });
  const answers = (calls) => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text);
  const pending = (ref, extra = {}) => store.set(ref, { ref, productId: 82, variant: 'v1', network: 'instagram', utmLink: `https://www.aynimar.com/store/82?utm_content=${ref}`, caption: 'Fuente <b>Pro</b> & agua\nPídelo', telegramFileId: 'F', telegramMessageId: 555, status: 'pending', createdAt: new Date(), ...extra });

  try {
    out('\n▶ Aprobar');
    n = tg.length;
    await post(cq('ap', REF));
    let calls = since(n);
    assert('pending → approved', store.get(REF).status === 'approved');
    assert('decided_by = id de Telegram del admin y decided_at', store.get(REF).decidedBy === ADMIN && store.get(REF).decidedAt instanceof Date);
    assert('UPDATE atómico condicionado a status=pending', updateCalls.at(-1).where.ref === REF && updateCalls.at(-1).where.status === 'pending');
    assert('answerCallbackQuery "✅ Aprobado"', answers(calls)[0] === '✅ Aprobado', JSON.stringify(answers(calls)));
    const rm = calls.find((c) => c.method === 'editMessageReplyMarkup');
    assert('botones retirados (inline_keyboard vacío) del mensaje del vídeo', rm && rm.body.message_id === 555 && rm.body.reply_markup.inline_keyboard.length === 0);
    const ec = calls.find((c) => c.method === 'editMessageCaption');
    assert('caption editado con línea de estado', ec && ec.body.caption.endsWith('Estado: ✅ Aprobado') && ec.body.caption.includes(`Ref: ${REF}`));
    const kit = calls.find((c) => c.method === 'sendMessage' && c.body.text.includes('KIT DE PUBLICACIÓN'));
    assert('kit enviado al admin como respuesta al vídeo', kit && String(kit.body.chat_id) === FAKE.ADMIN_ID && kit.body.reply_to_message_id === 555);
    assert('kit incluye caption para copiar, link UTM y pasos manuales', kit && kit.body.text.includes('<pre>') && kit.body.text.includes(store.get(REF).utmLink.replace(/&/g, '&amp;')) && kit.body.text.includes('Descargar') && kit.body.text.includes('Nada se publica automáticamente'));
    assert('kit escapa HTML del nombre de producto', kit && kit.body.text.includes('&lt;b&gt;Pro&lt;/b&gt; &amp; agua') && !kit.body.text.includes('<b>Pro</b>'));
    assert('aprobar NO publica en redes (solo llamadas a api.telegram.org)', calls.every((c) => ['answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageCaption', 'sendMessage'].includes(c.method)));

    out('\n▶ Idempotencia');
    n = tg.length;
    await post(cq('ap', REF));
    calls = since(n);
    assert('doble clic → sigue approved', store.get(REF).status === 'approved');
    assert('doble clic → responde "Ya decidido: ✅ Aprobado", sin editar ni reenviar kit', answers(calls)[0] === 'Ya decidido: ✅ Aprobado' && calls.length === 1);
    const decidedAt = store.get(REF).decidedAt;
    await post(cq('rj', REF));
    assert('rechazar tras aprobar → no cambia estado ni decided_at', store.get(REF).status === 'approved' && store.get(REF).decidedAt === decidedAt);

    out('\n▶ Ref inexistente y firma alterada');
    n = tg.length;
    await post(cq('ap', 'noexiste123'));
    calls = since(n);
    assert('ref inexistente → "Pieza no encontrada", sin ediciones', answers(calls)[0] === 'Pieza no encontrada.' && calls.length === 1);
    const R2 = 'v82xaltered';
    pending(R2);
    const before = updateCalls.length;
    const good = sec.signCallbackData('ap', R2);
    n = tg.length;
    await post(cq('ap', R2, { data: good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A') }));
    assert('firma alterada → "Acción no válida"', answers(since(n))[0] === '⛔ Acción no válida.');
    await post(cq('ap', R2, { data: sec.signCallbackData('rj', R2).replace('mk:rj:', 'mk:ap:') }));
    await post(cq('ap', R2, { from: 555555555 }));
    assert('firma alterada / acción cambiada / otro usuario → BD intacta', store.get(R2).status === 'pending' && updateCalls.length === before);

    out('\n▶ Rechazar');
    n = tg.length;
    await post(cq('rj', R2));
    calls = since(n);
    assert('pending → rejected', store.get(R2).status === 'rejected');
    assert('"❌ Rechazado" + botones retirados + confirmación', answers(calls)[0] === '❌ Rechazado' && calls.some((c) => c.method === 'editMessageReplyMarkup') && calls.some((c) => c.method === 'sendMessage' && c.body.text.includes('rechazada')));
    assert('rechazo no envía kit', !calls.some((c) => c.method === 'sendMessage' && c.body.text.includes('KIT')));

    out('\n▶ Pedir cambios + respuesta del admin');
    const R3 = 'v82xchanges';
    pending(R3);
    tgFail.add('editMessageCaption');
    n = tg.length;
    await post(cq('ch', R3));
    tgFail.delete('editMessageCaption');
    calls = since(n);
    assert('pending → changes_requested', store.get(R3).status === 'changes_requested');
    assert('"✏️ Cambios solicitados"', answers(calls)[0] === '✏️ Cambios solicitados');
    assert('editMessageCaption falla → estado como respuesta al vídeo', calls.some((c) => c.method === 'sendMessage' && c.body.reply_to_message_id === 555 && c.body.text.includes('Cambios solicitados')));
    const prompt = calls.find((c) => c.method === 'sendMessage' && c.body.text.includes('Responde'));
    assert('pide al admin responder con los cambios (incluye Ref)', prompt && prompt.body.text.includes(`Ref: ${R3}`));
    const videoMsg = { message_id: 555, from: { id: 111111, is_bot: true }, caption: reviewCaption(R3) };
    let fa = twoFA.length;
    n = tg.length;
    await post(msg('Cambia el texto final a "Oferta 123456" y quita la foto 3', { reply: videoMsg }));
    assert('reply al vídeo → change_request guardado', store.get(R3).changeRequest === 'Cambia el texto final a "Oferta 123456" y quita la foto 3');
    assert('reply guardado → confirmación y NO dispara el 2FA (aunque tenga 6 dígitos)', since(n).some((c) => c.method === 'sendMessage' && c.body.text.includes('Cambios guardados')) && twoFA.length === fa);
    await post(msg('Mejor fondo blanco', { reply: { message_id: 999, from: { id: 111111, is_bot: true }, text: prompt.body.text } }));
    assert('reply al mensaje de "Responde..." también guarda (y actualiza)', store.get(R3).changeRequest === 'Mejor fondo blanco');
    await post(msg('654321', { reply: videoMsg }));
    assert('reply con SOLO 6 dígitos → va al 2FA, no a cambios', twoFA.at(-1) === '654321' && store.get(R3).changeRequest === 'Mejor fondo blanco');
    await post(msg('quiero cambios', { reply: { ...videoMsg, caption: reviewCaption(REF) } }));
    assert('reply a una pieza aprobada → no guarda nada', store.get(REF).changeRequest === undefined && store.get(REF).status === 'approved');
    await post(msg('texto ajeno', { from: 555555555, chat: 555555555, reply: videoMsg }));
    assert('reply desde otro chat → ignorado', store.get(R3).changeRequest === 'Mejor fondo blanco');
    await post(msg('Ref: ' + R3 + ' aprobar'));
    assert('texto libre ("aprobar") nunca cambia estados', store.get(R3).status === 'changes_requested' && store.get(REF).status === 'approved');

    out('\n▶ 2FA de Dropi intacto');
    fa = twoFA.length;
    n = tg.length;
    await post(msg('mi código es 123456'));
    assert('admin envía 6 dígitos → completeManual2FA', twoFA.at(-1) === '123456' && twoFA.length === fa + 1);
    assert('respuesta ✅ de autenticación', since(n).some((c) => c.method === 'sendMessage' && c.body.text.includes('Autenticación exitosa')));

    out('\n▶ Error de BD al decidir');
    const R4 = 'v82xdberr';
    pending(R4);
    dbDown = true;
    n = tg.length;
    await post(cq('ap', R4));
    dbDown = false;
    calls = since(n);
    assert('BD caída → aviso en el botón, sin editar ni kit', answers(calls)[0].includes('No se pudo registrar') && calls.length === 1 && store.get(R4).status === 'pending');

    out('\n▶ Comandos /estado, /stop, /start');
    n = tg.length;
    await post(msg('/estado'));
    let st = since(n).find((c) => c.method === 'sendMessage');
    assert('/estado (admin) → lista con estados', st && st.body.text.includes(REF) && st.body.text.includes('✅ Aprobado') && st.body.text.includes('❌ Rechazado') && st.body.text.includes('OFF'));
    assert('/estado sin parse_mode (texto plano)', st && !st.body.parse_mode);
    for (let i = 0; i < 12; i++) pending(`v9x${i}`, { createdAt: new Date(Date.now() + 10000 + i) });
    n = tg.length;
    await post(msg('/estado'));
    st = since(n).find((c) => c.method === 'sendMessage');
    assert('/estado → solo las 10 últimas', st && (st.body.text.match(/^• /gm) || []).length === 10 && st.body.text.includes('v9x11') && !st.body.text.includes('v9x1 '));
    n = tg.length;
    await post(msg('/estado', { from: 555555555, chat: 555555555 }));
    await post(msg('/start', { from: 555555555, chat: 555555555 }));
    assert('/estado y /start desde otro chat → sin respuesta ni cambios', since(n).length === 0 && !settings.has('social.enabled'));
    await post(msg('/start'));
    assert('/start (admin) → social.enabled = true', settings.get('social.enabled') === 'true');
    await post(msg('/stop'));
    assert('/stop (admin) → social.enabled = false', settings.get('social.enabled') === 'false');
    assert('cambio del interruptor queda en el log', logs.some((l) => l.includes('interruptor de publicación → ON')) && logs.some((l) => l.includes('interruptor de publicación → OFF')));
    await post(msg('/stop', { from: 555555555, chat: 555555555 }));
    await post(msg('/start', { from: 555555555, chat: ADMIN }));
    assert('/start de otro usuario (aunque escriba en el chat admin) → ignorado', settings.get('social.enabled') === 'false');
  } finally {
    server.close();
  }

  out('\n▶ Ausencia de secretos en logs');
  const all = logs.join('\n');
  assert('logs sin token, secreto ni chat_id del admin', ![FAKE.BOT_TOKEN, FAKE.SECRET, FAKE.ADMIN_ID].some((x) => all.includes(x)));
  assert('logs sin el texto de los cambios ni códigos OTP', !all.includes('fondo blanco') && !['123456', '654321'].some((c) => all.includes(c)));

  out(`\n${'─'.repeat(50)}\nTelegram approvals tests: ${passed} passed, ${failed} failed\n`);
  if (failed) { console._error('Logs capturados:\n' + all); process.exit(1); }
  process.exit(0);
}

main().catch((err) => { console._error('Error inesperado en la suite:', err); process.exit(1); });
