'use strict';
/* eslint-disable no-console */
/**
 * Telegram Security Test Suite — F0
 *
 * Cero conexiones a DB. Cero llamadas reales a Telegram: global.fetch se
 * intercepta para api.telegram.org y el 2FA de Dropi se sustituye por un stub.
 * Levanta el router real (routes/aiRouter.js) en un puerto efímero local.
 *
 * Usage:
 *   node scripts/telegram-security-test.js
 *
 * Exit code 0 = all passed. Exit code 1 = at least one failure.
 */

const path = require('path');

// ── Entorno de prueba (valores ficticios, nunca credenciales reales) ─────────
const FAKE = {
  BOT_TOKEN:  '111111:FAKE-bot-token-for-tests-only',
  SECRET:     'test_webhook-SECRET_abc123',
  ADMIN_ID:   '987654321',
  JWT_SECRET: 'test-jwt-secret-only',
};
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k.startsWith('RAILWAY_')) delete process.env[k];
Object.assign(process.env, {
  // Parseable para construir Sequelize; ninguna ruta probada abre conexión (mismo patrón que smoke-test.js).
  DATABASE_URL:             'postgres://tgtest:test@localhost:5432/tgtest_never_connects',
  JWT_SECRET:               FAKE.JWT_SECRET,
  TELEGRAM_BOT_TOKEN:       FAKE.BOT_TOKEN,
  TELEGRAM_CHAT_ID:         FAKE.ADMIN_ID,
  TELEGRAM_WEBHOOK_SECRET:  FAKE.SECRET,
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  TELEGRAM_NONPROD_BOT_ID:  '111111',
});

// ── Captura de logs (para verificar que no filtran secretos) ─────────────────
const logs = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  console[`_${level}`] = console[level];
  console[level] = (...args) => logs.push(args.map(String).join(' '));
}
const out = (...a) => console._log(...a);

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { out(`  ✅ ${label}`); passed++; }
  else { console._error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── Stub de Telegram (fetch) y de Dropi 2FA ──────────────────────────────────
const realFetch = global.fetch;
const tgCalls = [];
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    const method = String(url).split('/').pop();
    tgCalls.push({ method, token: String(url).split('/bot')[1].split('/')[0], body: opts.body ? JSON.parse(opts.body) : null });
    const result = method === 'getWebhookInfo'
      ? { url: 'https://example.test/api/v1/ai/telegram/webhook', pending_update_count: 0, ip_address: '10.0.0.1', allowed_updates: ['message'] }
      : true;
    return { ok: true, json: async () => ({ ok: true, result }) };
  }
  return realFetch(url, opts);
};

const twoFACalls = [];
let twoFAShouldFail = false;
const dropiAuthPath = require.resolve(path.join(__dirname, '../integrations/dropi/dropiAuthService'));
require.cache[dropiAuthPath] = {
  id: dropiAuthPath, filename: dropiAuthPath, loaded: true,
  exports: {
    completeManual2FA: async (code) => {
      twoFACalls.push(code);
      if (twoFAShouldFail) throw new Error('codigo rechazado (stub)');
    },
  },
};

const sec = require('../libs/telegramSecurity');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1. Módulo puro ─────────────────────────────────────────────────────────
  out('\n▶ libs/telegramSecurity — funciones puras');
  assert('safeEqual iguales → true', sec.safeEqual('abc', 'abc'));
  assert('safeEqual distintos / distinta longitud → false', !sec.safeEqual('abc', 'abd') && !sec.safeEqual('abc', 'abcd'));
  assert('safeEqual no-string → false', !sec.safeEqual(undefined, 'abc') && !sec.safeEqual(null, null));
  assert('isValidWebhookSecret correcto → true', sec.isValidWebhookSecret(FAKE.SECRET));
  assert('isValidWebhookSecret incorrecto/ausente → false', !sec.isValidWebhookSecret('x') && !sec.isValidWebhookSecret(undefined) && !sec.isValidWebhookSecret(''));
  assert('isValidWebhookSecret sin secreto en entorno → false (fail-closed)', !sec.isValidWebhookSecret('', {}) && !sec.isValidWebhookSecret('anything', {}));
  assert('botIdFromToken extrae el id público', sec.botIdFromToken(FAKE.BOT_TOKEN) === '111111' && sec.botIdFromToken('basura') === null);
  assert('maskId deja solo 4 dígitos', sec.maskId('987654321') === '*****4321' && sec.maskId(null) === null);

  // setWebhook
  const w1 = sec.buildSetWebhookBody('https://s.test/hook');
  assert('setWebhook incluye secret_token', w1.body?.secret_token === FAKE.SECRET);
  assert('setWebhook SIN allowed_updates cuando no se configura (production no cambia)', w1.body && !('allowed_updates' in w1.body));
  const w2 = sec.buildSetWebhookBody('https://s.test/hook', { TELEGRAM_WEBHOOK_SECRET: FAKE.SECRET, TELEGRAM_ALLOWED_UPDATES: 'message, callback_query' });
  assert('setWebhook con TELEGRAM_ALLOWED_UPDATES → lista explícita', JSON.stringify(w2.body?.allowed_updates) === '["message","callback_query"]');
  assert('setWebhook rechaza tipos desconocidos', !!sec.buildSetWebhookBody('u', { TELEGRAM_WEBHOOK_SECRET: FAKE.SECRET, TELEGRAM_ALLOWED_UPDATES: 'message,inline_query' }).error);
  assert('setWebhook sin secreto → error (no registra)', !!sec.buildSetWebhookBody('u', {}).error);
  assert('setWebhook con secreto de formato inválido → error', !!sec.buildSetWebhookBody('u', { TELEGRAM_WEBHOOK_SECRET: 'con espacios!' }).error);
  assert('mensaje de error de setWebhook no contiene el secreto', !String(sec.buildSetWebhookBody('u', { TELEGRAM_WEBHOOK_SECRET: 'bad secret' }).error).includes('bad secret'));

  // ── 2. Aislamiento staging / producción ────────────────────────────────────
  out('\n▶ Aislamiento del bot de staging frente al productivo');
  const PROD_LIKE = '222222:PROD-like-token';
  assert('production → token disponible (comportamiento actual)', sec.getTelegramToken({ RAILWAY_ENVIRONMENT_NAME: 'production', TELEGRAM_BOT_TOKEN: PROD_LIKE }) === PROD_LIKE);
  assert('staging sin TELEGRAM_NONPROD_BOT_ID → bloqueado', sec.getTelegramToken({ RAILWAY_ENVIRONMENT_NAME: 'staging', TELEGRAM_BOT_TOKEN: PROD_LIKE }) === null);
  assert('staging con token de OTRO bot (p.ej. el productivo) → bloqueado', sec.getTelegramToken({ RAILWAY_ENVIRONMENT_NAME: 'staging', TELEGRAM_BOT_TOKEN: PROD_LIKE, TELEGRAM_NONPROD_BOT_ID: '111111' }) === null);
  assert('staging con su bot de pruebas → permitido', sec.getTelegramToken({ RAILWAY_ENVIRONMENT_NAME: 'staging', TELEGRAM_BOT_TOKEN: FAKE.BOT_TOKEN, TELEGRAM_NONPROD_BOT_ID: '111111' }) === FAKE.BOT_TOKEN);
  assert('local (sin RAILWAY_ENVIRONMENT_NAME) se trata como no-productivo', sec.getTelegramToken({ TELEGRAM_BOT_TOKEN: PROD_LIKE }) === null);
  assert('razón de bloqueo no contiene el token', !String(sec.telegramDisabledReason({ RAILWAY_ENVIRONMENT_NAME: 'staging', TELEGRAM_BOT_TOKEN: PROD_LIKE })).includes(PROD_LIKE));

  // Emisor real (utils/telegramNotify) con token "productivo" en staging → 0 llamadas.
  const { sendTelegramNotification } = require('../utils/telegramNotify');
  process.env.TELEGRAM_BOT_TOKEN = PROD_LIKE;
  const before = tgCalls.length;
  await sendTelegramNotification('prueba');
  assert('telegramNotify en staging con token ajeno → no envía nada', tgCalls.length === before);
  process.env.TELEGRAM_BOT_TOKEN = FAKE.BOT_TOKEN;
  await sendTelegramNotification('prueba');
  assert('telegramNotify en staging con su bot → envía (con el bot de pruebas)', tgCalls.length === before + 1 && tgCalls.at(-1).token === FAKE.BOT_TOKEN);

  // ── 3. Router real ─────────────────────────────────────────────────────────
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  // F2: la decisión se prueba en scripts/telegram-approvals-test.js; aquí solo
  // se comprueba que un callback válido llega a esa capa (sin BD).
  const reviewCalls = [];
  require('../Services/creativeReviewService').decide = async (...a) => { reviewCalls.push(a); return { changed: false, review: null }; };
  const aiRouter = require('../routes/aiRouter');
  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');

  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', aiRouter);
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ai`;
  const bodies = [];

  async function post(update, secret) {
    const headers = { 'Content-Type': 'application/json' };
    if (secret !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
    const r = await realFetch(`${base}/telegram/webhook`, { method: 'POST', headers, body: JSON.stringify(update) });
    const text = await r.text();
    bodies.push(text);
    await sleep(60); // el handler responde antes de procesar
    return r.status;
  }
  async function getDebug(token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await realFetch(`${base}/telegram/debug`, { headers });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, text };
  }
  const msgUpdate = (text, chatId = FAKE.ADMIN_ID) => ({ update_id: 1, message: { message_id: 1, chat: { id: Number(chatId) }, from: { id: Number(chatId) }, text } });

  try {
    out('\n▶ Webhook — validación del secreto');
    let calls = twoFACalls.length;
    assert('secreto correcto → 200', await post(msgUpdate('hola'), FAKE.SECRET) === 200);
    assert('secreto correcto + mensaje normal → no dispara 2FA', twoFACalls.length === calls);
    assert('secreto incorrecto → 403', await post(msgUpdate('123456'), 'otro-secreto') === 403);
    assert('sin header de secreto → 403', await post(msgUpdate('123456'), undefined) === 403);
    assert('secreto incorrecto/ausente → 2FA NO procesado', twoFACalls.length === calls);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    assert('entorno sin TELEGRAM_WEBHOOK_SECRET → 503 (fail-closed)', await post(msgUpdate('123456'), 'cualquiera') === 503);
    assert('entorno sin secreto → 2FA NO procesado', twoFACalls.length === calls);
    process.env.TELEGRAM_WEBHOOK_SECRET = FAKE.SECRET;

    out('\n▶ Webhook — compatibilidad del 2FA de Dropi');
    let sent = tgCalls.length;
    assert('admin envía 6 dígitos → 200', await post(msgUpdate('mi código es 123456'), FAKE.SECRET) === 200);
    assert('completeManual2FA recibe el código', twoFACalls.at(-1) === '123456' && twoFACalls.length === calls + 1);
    const okMsg = tgCalls.slice(sent).find((c) => c.method === 'sendMessage');
    assert('responde ✅ al chat del admin', okMsg && String(okMsg.body.chat_id) === FAKE.ADMIN_ID && okMsg.body.text.includes('Autenticación exitosa'));
    calls = twoFACalls.length;
    await post(msgUpdate('123456', '555555555'), FAKE.SECRET);
    assert('otro chat envía 6 dígitos → ignorado', twoFACalls.length === calls);
    twoFAShouldFail = true; sent = tgCalls.length;
    await post(msgUpdate('654321'), FAKE.SECRET);
    const errMsg = tgCalls.slice(sent).find((c) => c.method === 'sendMessage');
    assert('2FA fallido → responde ❌ al admin', errMsg && errMsg.body.text.includes('Error de autenticación'));
    twoFAShouldFail = false;
    calls = twoFACalls.length;
    await post({ update_id: 9, channel_post: { chat: { id: Number(FAKE.ADMIN_ID) }, text: '111222' } }, FAKE.SECRET);
    assert('channel_post del chat admin sigue aceptado (comportamiento previo)', twoFACalls.length === calls + 1);

    out('\n▶ Webhook — callback_query (verificación previa a las aprobaciones F2)');
    const good = sec.signCallbackData('ap', 'abc123');
    assert('callback_data firmado ≤ 64 bytes', Buffer.byteLength(good) <= 64, good);
    const cq = (data, fromId = FAKE.ADMIN_ID, chatId = FAKE.ADMIN_ID) => ({ update_id: 2, callback_query: { id: 'cq1', from: { id: Number(fromId) }, message: { chat: { id: Number(chatId) } }, data } });
    const lastAnswer = () => tgCalls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
    const verdictLog = () => logs.filter((l) => l.includes('callback_query')).at(-1) || '';
    calls = twoFACalls.length;

    await post(cq(good), FAKE.SECRET);
    assert('callback válido del admin → llega a la decisión F2 (ref inexistente → "no encontrada")', reviewCalls.length === 1 && reviewCalls[0][0] === 'abc123' && lastAnswer()?.body.text.includes('no encontrada'));
    const tamperedSig = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    await post(cq(tamperedSig), FAKE.SECRET);
    assert('firma manipulada → rechazado (bad_signature)', verdictLog().includes('bad_signature') && lastAnswer()?.body.text.includes('no válida'));
    await post(cq(good.replace('mk:ap:', 'mk:rj:')), FAKE.SECRET);
    assert('acción cambiada (ap→rj) con firma original → rechazado', verdictLog().includes('bad_signature'));
    await post(cq('mk:xx:abc123:AAAAAAAAAAAAAAAA'), FAKE.SECRET);
    assert('acción desconocida → rechazado', verdictLog().includes('unknown_action'));
    await post(cq('aprobar campaña 5'), FAKE.SECRET);
    assert('callback_data malformado/texto libre → rechazado', verdictLog().includes('malformed'));
    await post(cq(good, '555555555', '555555555'), FAKE.SECRET);
    assert('callback de otro usuario (aunque firma válida) → rechazado', verdictLog().includes('unauthorized_user'));
    await post(cq(good, FAKE.ADMIN_ID, '-100123'), FAKE.SECRET);
    assert('callback del admin desde otro chat/grupo → rechazado', verdictLog().includes('unauthorized_chat'));
    const otherKey = sec.signCallbackData('ap', 'abc123', { TELEGRAM_WEBHOOK_SECRET: 'otro_secreto' });
    await post(cq(otherKey), FAKE.SECRET);
    assert('firmado con otra clave (botón de un secreto rotado) → rechazado', verdictLog().includes('bad_signature'));
    assert('callback con firma válida pero sin secreto de webhook → 403', await post(cq(good), undefined) === 403);
    await post(cq('mk:ap:123456:AAAAAAAAAAAAAAAA'), FAKE.SECRET);
    assert('ningún callback dispara el 2FA de Dropi', twoFACalls.length === calls);
    assert('ningún callback rechazado llega a la capa de decisión', reviewCalls.length === 1);

    out('\n▶ Endpoint de diagnóstico /telegram/debug');
    const noAuth = await getDebug(null);
    assert('sin autorización → 401', noAuth.status === 401, String(noAuth.status));
    const custTok = jwt.sign({ sub: 2, role: 'customer' }, FAKE.JWT_SECRET);
    assert('JWT de rol no-admin → 403', (await getDebug(custTok)).status === 403);
    const badTok = jwt.sign({ sub: 1, role: 'admin' }, 'otra-clave');
    assert('JWT firmado con otra clave → 401', (await getDebug(badTok)).status === 401);
    const adminTok = jwt.sign({ sub: 1, role: 'admin' }, FAKE.JWT_SECRET);
    const ok = await getDebug(adminTok);
    const okJson = JSON.parse(ok.text);
    assert('admin → 200 con estado del webhook', ok.status === 200 && okJson.webhook_info.url.endsWith('/telegram/webhook'));
    assert('admin → chat_id enmascarado (no completo)', okJson.local_state.admin_chat_id === '*****4321' && !ok.text.includes(FAKE.ADMIN_ID));
    assert('admin → no devuelve ip_address ni secreto', !ok.text.includes('10.0.0.1') && !ok.text.includes(FAKE.SECRET) && okJson.local_state.webhook_secret_set === true);
  } finally {
    server.close();
  }

  // ── 4. Ausencia de secretos en logs y respuestas ───────────────────────────
  out('\n▶ Ausencia de secretos en logs y respuestas HTTP');
  const allLogs = logs.join('\n');
  const allBodies = bodies.join('\n');
  assert('logs no contienen el token del bot', !allLogs.includes(FAKE.BOT_TOKEN) && !allLogs.includes('PROD-like-token'));
  assert('logs no contienen el secreto del webhook', !allLogs.includes(FAKE.SECRET));
  assert('logs no contienen los códigos OTP enviados', !['123456', '654321', '111222'].some((c) => allLogs.includes(c)));
  assert('logs no contienen el chat_id del admin', !allLogs.includes(FAKE.ADMIN_ID));
  assert('respuestas HTTP no contienen token, secreto ni chat_id', ![FAKE.BOT_TOKEN, FAKE.SECRET, FAKE.ADMIN_ID].some((s) => allBodies.includes(s)));

  out(`\n${'─'.repeat(50)}\nTelegram security tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console._error('Logs capturados:\n' + allLogs);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console._error('Error inesperado en la suite:', err);
  process.exit(1);
});
