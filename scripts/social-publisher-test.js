'use strict';
/* eslint-disable no-console */
/* global Headers, FormData */
/**
 * Social Publisher Test Suite — calendario + aprobación por Telegram + cola Postgres.
 *
 * Parte A (siempre): hash del paquete, zonas horarias, validación de formato, rutas por red,
 *   adaptadores reales contra APIs FALSAS (fetch interceptado: nunca sale a Meta/Google/Buffer).
 * Parte B (solo con SOCIAL_TEST_DATABASE_URL): Postgres REAL en un schema temporal
 *   social_test_<pid> (search_path), que se borra al terminar. Aborta si el host parece
 *   producción (roundhouse*). Lanza 2 procesos worker hijos + el propio proceso en paralelo.
 *
 * Usage: SOCIAL_TEST_DATABASE_URL=postgres://… node scripts/social-publisher-test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WORKER = process.argv[2] === '--worker';
const FAKE = {
  BOT_TOKEN: '111111:FAKE-bot-token-for-tests-only',
  SECRET: 'test_webhook-SECRET_abc123',
  ADMIN_ID: '987654321',
  META: 'FAKE-meta-system-user-token',
  BUFFER: 'FAKE-buffer-api-key',
  YT_SECRET: 'FAKE-yt-client-secret',
};
const VIDEO = Buffer.from('fake mp4 bytes for the approved piece');
const VIDEO_SHA = crypto.createHash('sha256').update(VIDEO).digest('hex');
// M1: ruta direccionada por contenido (contiene el sha256).
const VIDEO_URL = `https://firebasestorage.googleapis.com/v0/b/test/o/videos%2F${VIDEO_SHA}.mp4?alt=media&token=t`;
const tampered = new Set(); // rutas de Storage que devuelven OTROS bytes (archivo cambiado tras subirlo)

if (!IS_WORKER) {
  for (const k of Object.keys(process.env)) if (/^(TELEGRAM_|RAILWAY_|META_|BUFFER_|YOUTUBE_|SOCIAL_)/.test(k) && k !== 'SOCIAL_TEST_DATABASE_URL' || k === 'REDIS_URL' || k === 'STORE_BASE_URL') delete process.env[k];
  Object.assign(process.env, {
    JWT_SECRET: 'test-jwt-secret-only',
    TELEGRAM_BOT_TOKEN: FAKE.BOT_TOKEN, TELEGRAM_CHAT_ID: FAKE.ADMIN_ID, TELEGRAM_WEBHOOK_SECRET: FAKE.SECRET,
    RAILWAY_ENVIRONMENT_NAME: 'staging', TELEGRAM_NONPROD_BOT_ID: '111111',
    META_SYSTEM_USER_TOKEN: FAKE.META, META_IG_USER_ID: '1789', BUFFER_API_KEY: FAKE.BUFFER, BUFFER_CHANNEL_TIKTOK: 'chan_tt',
    SOCIAL_ALLOWED_NETWORKS: 'mock,instagram,tiktok', // youtube y facebook NO autorizadas
    SOCIAL_RETRY_BASE_MS: '50',
  });
}

const logs = [];
const out = (...a) => (console._log || console.log)(...a);
if (!IS_WORKER) {
  for (const level of ['log', 'warn', 'error', 'info']) {
    console[`_${level}`] = console[level];
    console[level] = (...args) => logs.push(args.map(String).join(' '));
  }
}
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { out(`  ✅ ${label}`); passed++; } else { console._error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(60); }
  return false;
}

// ── APIs falsas (Telegram, Graph, Buffer, Google, almacenamiento) ─────────────
const realFetch = global.fetch;
const tg = [];
const api = [];
let seq = 1000;
const mockLog = () => process.env.SOCIAL_MOCK_LOG;
const record = (rec) => { if (mockLog()) fs.appendFileSync(mockLog(), `${JSON.stringify({ ...rec, pid: process.pid })}\n`); };
const jsonResp = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, statusText: String(status),
  headers: new Headers(headers), text: async () => JSON.stringify(body), json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});
const graphFail = { media: [], publish: [] }; // códigos HTTP a devolver en orden (pruebas de clasificación)

global.fetch = async (url, opts = {}) => {
  const s = String(url);
  const u = new URL(s);
  if (u.hostname === 'api.telegram.org') {
    const method = s.split('/').pop();
    let body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    if (opts.body instanceof FormData) { // subida multipart: campos + sha256 de los bytes subidos
      const f = opts.body.get('video');
      body = { chat_id: opts.body.get('chat_id'), caption: opts.body.get('caption'), videoSha: f && typeof f !== 'string' ? crypto.createHash('sha256').update(Buffer.from(await f.arrayBuffer())).digest('hex') : f };
    }
    tg.push({ method, body });
    const result = ['sendVideo', 'sendMessage'].includes(method) ? { message_id: ++seq, ...(method === 'sendVideo' ? { video: { file_id: `TGFILE-${seq}` } } : {}) } : true;
    return jsonResp(200, { ok: true, result });
  }
  api.push({ host: u.hostname, path: u.pathname, search: u.search, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  if (u.hostname === 'firebasestorage.googleapis.com') {
    const buf = tampered.has(u.pathname) ? Buffer.from('otro archivo') : VIDEO;
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(buf.length) }), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
  if (u.hostname === 'graph.facebook.com') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (u.pathname.endsWith('/media') && opts.method === 'POST') {
      const code = graphFail.media.shift();
      if (code) return jsonResp(code, { error: { message: `fake ${code}` } });
      return jsonResp(200, { id: `cont_${body.caption.length}_${++seq}` });
    }
    if (u.pathname.endsWith('/media_publish')) {
      const code = graphFail.publish.shift();
      if (code) return jsonResp(code, { error: { message: `fake ${code}` } });
      const id = `ig_${++seq}`;
      record({ network: 'instagram', creation: body.creation_id, mediaId: id });
      return jsonResp(200, { id });
    }
    if (u.search.includes('status_code')) return jsonResp(200, { status_code: 'FINISHED' });
    if (u.search.includes('permalink')) return jsonResp(200, { id: u.pathname.split('/').pop(), permalink: `https://instagram.com/reel/${u.pathname.split('/').pop()}` });
    if (u.search.includes('access_token')) return jsonResp(200, { access_token: 'FAKE-page-token', id: '55' });
    if (u.pathname.endsWith('/video_reels')) return jsonResp(200, body.upload_phase === 'start' ? { video_id: 'fbv_1', upload_url: 'x' } : { success: true });
    if (u.search.includes('fields=status')) return jsonResp(200, { status: { video_status: 'ready' } });
  }
  if (u.hostname === 'rupload.facebook.com') return jsonResp(200, { success: true });
  if (u.hostname === 'api.buffer.com') {
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes('createPost')) {
      const id = `buf_${++seq}`;
      record({ network: variables.input.channelId === 'chan_tt' ? 'tiktok' : 'buffer:other', bufferId: id, text: variables.input.text });
      return jsonResp(200, { data: { createPost: { post: { id, status: 'sending', externalLink: null } } } });
    }
    return jsonResp(200, { data: { post: { id: variables.input.id, status: 'sent', externalLink: 'https://tiktok.com/@x/video/1' } } });
  }
  if (u.hostname === 'oauth2.googleapis.com') return jsonResp(200, { access_token: 'FAKE-yt-access' });
  if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/upload/')) {
    if (opts.method === 'POST') return jsonResp(200, {}, { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc' });
    return jsonResp(200, { id: 'yt_1' });
  }
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  throw Object.assign(new Error(`red real bloqueada en tests: ${u.hostname}`), { code: 'ECONNREFUSED' });
};

// ── Parte A: sin BD ──────────────────────────────────────────────────────────
async function partA() {
  const social = require('../integrations/social');
  const { PublishError } = require('../integrations/social/http');
  const svc = require('../Services/socialPublisherService');

  out('\n▶ A0. Autoaprobación orgánica (interruptor apagado por defecto)');
  const org = { campaign_content_type: 'Organico' };
  assert('sin SOCIAL_AUTO_APPROVE_ORGANIC → nunca autoaprueba', !svc.autoApprovesOrganic(org, {}));
  assert('interruptor ON + campaña orgánica → autoaprueba', svc.autoApprovesOrganic(org, { SOCIAL_AUTO_APPROVE_ORGANIC: 'true' }) && svc.autoApprovesOrganic({ campaign_content_type: 'orgánico' }, { SOCIAL_AUTO_APPROVE_ORGANIC: 'true' }));
  assert('interruptor ON + campaña no orgánica / valor ≠ "true" → no', !svc.autoApprovesOrganic({ campaign_content_type: 'reel' }, { SOCIAL_AUTO_APPROVE_ORGANIC: 'true' }) && !svc.autoApprovesOrganic({}, { SOCIAL_AUTO_APPROVE_ORGANIC: 'true' }) && !svc.autoApprovesOrganic(org, { SOCIAL_AUTO_APPROVE_ORGANIC: '1' }));

  out('\n▶ A1. Hash del paquete y zona horaria');
  const piece = { ref: 'v82xabc', version: 1, video_sha256: VIDEO_SHA };
  const posts = [
    { network: 'tiktok', channel: 'buffer', scheduled_at: '2026-10-21T00:00:00Z', timezone: 'America/Guayaquil', caption: 'Hola', utm_link: 'u1' },
    { network: 'instagram', channel: 'api', scheduled_at: '2026-10-21T00:00:00Z', timezone: 'America/Guayaquil', caption: 'Hola', utm_link: 'u2' },
  ];
  const h = svc.packageHash(piece, posts);
  assert('hash determinista e independiente del orden de las redes', h === svc.packageHash(piece, [...posts].reverse()) && /^[0-9a-f]{64}$/.test(h));
  assert('cambiar texto / horario / canal / vídeo / versión cambia el hash', [
    svc.packageHash(piece, [{ ...posts[0], caption: 'Hola!' }, posts[1]]),
    svc.packageHash(piece, [{ ...posts[0], scheduled_at: '2026-10-21T00:01:00Z' }, posts[1]]),
    svc.packageHash(piece, [{ ...posts[0], channel: 'manual' }, posts[1]]),
    svc.packageHash({ ...piece, video_sha256: 'f'.repeat(64) }, posts),
    svc.packageHash({ ...piece, version: 2 }, posts),
    svc.packageHash(piece, [posts[0]]),
  ].every((x) => x !== h));
  assert('19:00 America/Guayaquil = 00:00Z del día siguiente', svc.toUtc('2026-10-20T19:00', 'America/Guayaquil').toISOString() === '2026-10-21T00:00:00.000Z');
  assert('ISO con offset se respeta', svc.toUtc('2026-10-20T19:00:00-05:00').toISOString() === '2026-10-21T00:00:00.000Z');
  assert('zona con horario de verano (Madrid, octubre) correcta', svc.toUtc('2026-07-01T12:00', 'Europe/Madrid').toISOString() === '2026-07-01T10:00:00.000Z');
  assert('zona inválida detectada', !svc.isValidTimeZone('Mars/Base') && svc.isValidTimeZone('America/Guayaquil'));
  const r = svc.newReviewRef(123456);
  assert('ref de paquete ≤32 [A-Za-z0-9_-] y reconocible', r.length <= 32 && /^[A-Za-z0-9_-]+$/.test(r) && svc.isPackageRef(r) && !svc.isPackageRef('v82xabc'));

  out('\n▶ A2. Validación de formato por red');
  const ok = { width: 1080, height: 1920, durationS: 30, bytes: 8e6 };
  assert('9:16, 30 s, texto corto → válido en todas', ['instagram', 'facebook', 'tiktok', 'youtube', 'mock'].every((n) => social.validateFormat(n, ok, 'Hola #aynimar').length === 0));
  assert('1:1 rechazado', social.validateFormat('instagram', { ...ok, height: 1080 }, 'x').some((e) => e.includes('9:16')));
  assert('Facebook Reels > 90 s rechazado', social.validateFormat('facebook', { ...ok, durationS: 120 }, 'x').some((e) => e.includes('duración')));
  assert('Facebook < 540 px de ancho rechazado', social.validateFormat('facebook', { ...ok, width: 450, height: 800 }, 'x').some((e) => e.includes('ancho')));
  assert('YouTube Short > 180 s rechazado', social.validateFormat('youtube', { ...ok, durationS: 200 }, 'x').length > 0);
  assert('YouTube con < > rechazado', social.validateFormat('youtube', ok, 'precio <b>').some((e) => e.includes('YouTube')));
  assert('Instagram: 31 hashtags rechazado', social.validateFormat('instagram', ok, Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')).some((e) => e.includes('hashtags')));
  assert('Instagram: texto > 2200 rechazado', social.validateFormat('instagram', ok, 'a'.repeat(2201)).some((e) => e.includes('2200')));
  assert('Instagram: > 300 MB rechazado', social.validateFormat('instagram', { ...ok, bytes: 400 * 1024 * 1024 }, 'x').some((e) => e.includes('MB')));

  out('\n▶ A3. Lista blanca, vía única por red y estado de credenciales');
  assert('sin SOCIAL_ALLOWED_NETWORKS → ninguna red', social.allowedNetworks({}).length === 0);
  assert('mock nunca autorizada en production', !social.allowedNetworks({ SOCIAL_ALLOWED_NETWORKS: 'mock,instagram', RAILWAY_ENVIRONMENT_NAME: 'production' }).includes('mock'));
  const routes = social.networkRoutes({});
  assert('rutas por defecto: IG/FB/YT api, TikTok buffer', routes.instagram === 'api' && routes.facebook === 'api' && routes.youtube === 'api' && routes.tiktok === 'buffer');
  assert('TikTok por API propia no se admite (→ buffer)', social.networkRoutes({ SOCIAL_NETWORK_CHANNELS: 'tiktok:api' }).tiktok === 'buffer');
  assert('YouTube configurable a buffer', social.networkRoutes({ SOCIAL_NETWORK_CHANNELS: 'youtube:buffer' }).youtube === 'buffer');
  const cs = social.configStatus({});
  assert('sin variables → reales NO CONFIGURADO', ['instagram', 'facebook', 'tiktok', 'youtube'].every((n) => cs[n].configured === 'NO CONFIGURADO'));
  const cs2 = social.configStatus(process.env);
  assert('con variables → CONFIGURADO, y sin valores en la salida', cs2.instagram.configured === 'CONFIGURADO' && cs2.tiktok.configured === 'CONFIGURADO' && !JSON.stringify(cs2).includes(FAKE.META) && !JSON.stringify(cs2).includes(FAKE.BUFFER));
  assert('envVars por red (nombres)', cs2.tiktok.envVars.join() === 'BUFFER_API_KEY,BUFFER_CHANNEL_TIKTOK' && cs2.facebook.envVars.includes('META_PAGE_ID'));
  assert('getAdapter: tiktok solo por buffer; manual nunca publica', social.getAdapter('tiktok', 'api') === null && social.getAdapter('tiktok', 'buffer') && social.getAdapter('instagram', 'manual') === null);

  out('\n▶ A4. Adaptadores reales contra APIs falsas');
  const ctx = { fetch: global.fetch, env: process.env, sleep: async () => {} };
  const post = { id: 1, network: 'instagram', caption: 'Hola #aynimar', attempts: 1 };
  const video = { url: VIDEO_URL, buffer: VIDEO, sha256: VIDEO_SHA };
  let n = api.length;
  const ig = await social.getAdapter('instagram', 'api').publish({ post, piece: {}, video }, ctx);
  const igCalls = api.slice(n);
  assert('IG: contenedor REELS → estado → media_publish → permalink', ig.externalId.startsWith('ig_') && ig.url.includes('instagram.com/reel/') && igCalls.map((c) => c.path.split('/').pop()).slice(0, 3).join() === 'media,' + igCalls[1].path.split('/').pop() + ',media_publish');
  const c0 = JSON.parse(igCalls[0].body);
  assert('IG: media_type=REELS, video_url y caption exactos', c0.media_type === 'REELS' && c0.video_url === VIDEO_URL && c0.caption === post.caption);
  assert('IG: token en header Authorization, nunca en la URL', igCalls.every((c) => c.headers.Authorization === `Bearer ${FAKE.META}` && !c.search.includes(FAKE.META)));
  const kindOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e instanceof PublishError ? e.kind : `raw:${e.message}`; } };
  graphFail.media.push(429);
  assert('IG: 429 en contenedor → temporary', await kindOf(() => social.getAdapter('instagram', 'api').publish({ post, piece: {}, video }, ctx)) === 'temporary');
  graphFail.media.push(400);
  assert('IG: 400 en contenedor → permanent', await kindOf(() => social.getAdapter('instagram', 'api').publish({ post, piece: {}, video }, ctx)) === 'permanent');
  graphFail.publish.push(502);
  assert('IG: 5xx en media_publish (paso final) → unknown (no se reintenta)', await kindOf(() => social.getAdapter('instagram', 'api').publish({ post, piece: {}, video }, ctx)) === 'unknown');
  const envFb = { ...process.env, META_PAGE_ID: '55' };
  n = api.length;
  const fb = await social.getAdapter('facebook', 'api').publish({ post: { ...post, network: 'facebook' }, piece: {}, video }, { ...ctx, env: envFb });
  const fbCalls = api.slice(n);
  assert('FB: token de página → start → rupload con file_url → finish PUBLISHED', fb.externalId === 'fbv_1' &&
    fbCalls.some((c) => c.host === 'rupload.facebook.com' && c.headers.file_url === VIDEO_URL) &&
    fbCalls.some((c) => c.body && JSON.parse(c.body).video_state === 'PUBLISHED' && JSON.parse(c.body).description === post.caption));
  const envYt = { ...process.env, YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: FAKE.YT_SECRET, YOUTUBE_REFRESH_TOKEN: 'FAKE-refresh' };
  n = api.length;
  const yt = await social.getAdapter('youtube', 'api').publish({ post: { ...post, network: 'youtube', caption: 'Fuente Pro\nDetalle' }, piece: {}, video }, { ...ctx, env: envYt });
  const ytCalls = api.slice(n);
  const ytMeta = JSON.parse(ytCalls[1].body);
  assert('YT: refresh token → subida reanudable → PUT bytes → URL de Short', yt.url === 'https://www.youtube.com/shorts/yt_1' && ytCalls[2].method === 'PUT' && ytCalls[2].body === VIDEO);
  assert('YT: título = 1ª línea, privacidad por defecto private', ytMeta.snippet.title === 'Fuente Pro' && ytMeta.status.privacyStatus === 'private');
  const ytNoStatus = async () => {
    const f = async (url) => (String(url).includes('oauth2') ? jsonResp(200, { access_token: 'FAKE-yt-access' }) : jsonResp(200, { items: [] }));
    return social.getAdapter('youtube', 'api').verify({ externalId: 'yt_1' }, { ...ctx, env: envYt, fetch: f });
  };
  assert('B8: YT recién subido sin status → null (pendiente), no false', (await ytNoStatus()) === null);
  n = api.length;
  const bf = await social.getAdapter('tiktok', 'buffer').publish({ post: { ...post, network: 'tiktok' }, piece: {}, video }, ctx);
  const bfBody = JSON.parse(api[n].body);
  assert('Buffer: createPost shareNow con vídeo y canal de TikTok', bf.externalId.startsWith('buf_') && bfBody.variables.input.mode === 'shareNow' && bfBody.variables.input.channelId === 'chan_tt' && bfBody.variables.input.assets[0].video.url === VIDEO_URL);
  assert('Buffer: verify "sent" → true', (await social.getAdapter('tiktok', 'buffer').verify({ externalId: bf.externalId }, ctx)) === true);
  const bfErr = async (payload) => {
    const save = global.fetch;
    global.fetch = async () => jsonResp(200, payload);
    try { return await kindOf(() => social.getAdapter('tiktok', 'buffer').publish({ post: { ...post, network: 'tiktok' }, piece: {}, video }, { ...ctx, fetch: global.fetch })); } finally { global.fetch = save; }
  };
  assert('Buffer: RATE_LIMIT_EXCEEDED → temporary', await bfErr({ errors: [{ message: 'x', extensions: { code: 'RATE_LIMIT_EXCEEDED' } }] }) === 'temporary');
  assert('Buffer: UNAUTHORIZED → permanent', await bfErr({ errors: [{ message: 'x', extensions: { code: 'UNAUTHORIZED' } }] }) === 'permanent');
  assert('Buffer: MutationError (límite de cola) → permanent', await bfErr({ data: { createPost: { message: 'Queue limit reached' } } }) === 'permanent');
  assert('Buffer: UNEXPECTED en createPost → unknown', await bfErr({ errors: [{ message: 'x', extensions: { code: 'UNEXPECTED' } }] }) === 'unknown');
  const save = global.fetch;
  global.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  assert('timeout en el paso final → unknown; conexión rechazada → temporary', await kindOf(() => social.getAdapter('tiktok', 'buffer').publish({ post: { ...post, network: 'tiktok' }, piece: {}, video }, { ...ctx, fetch: global.fetch })) === 'unknown');
  global.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  assert('…conexión rechazada → temporary', await kindOf(() => social.getAdapter('tiktok', 'buffer').publish({ post: { ...post, network: 'tiktok' }, piece: {}, video }, { ...ctx, fetch: global.fetch })) === 'temporary');
  global.fetch = save;
}

// ── Parte B: Postgres real ───────────────────────────────────────────────────
async function setupDb() {
  const raw = process.env.SOCIAL_TEST_DATABASE_URL;
  const host = new URL(raw).hostname;
  if (/^roundhouse/i.test(host)) { console._error('ABORT: el host parece PRODUCCIÓN'); process.exit(2); }
  if (!/^(altaria|localhost$|127\.0\.0\.1$)/.test(host)) { console._error('ABORT: host no reconocido como staging/local'); process.exit(2); }
  const schema = `social_test_${process.pid}`;
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw, ssl: false });
  await c.connect();
  await c.query(`CREATE SCHEMA "${schema}"`);
  await c.end();
  const u = new URL(raw);
  u.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = u.toString();
  return { raw, schema };
}

async function dropSchema(raw, schema) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw, ssl: false });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await c.end();
}

/** Proceso worker hijo: `ready` cuando ya está conectado y sondeando; `done` al vaciarse la cola. */
function spawnWorker(env) {
  const p = spawn(process.execPath, [__filename, '--worker'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '';
  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  p.stdout.on('data', (d) => { o += d; if (o.includes('READY')) markReady(); });
  p.stderr.on('data', (d) => { o += d; });
  const done = new Promise((resolve) => p.on('close', (code) => { markReady(); resolve({ code, out: o }); }));
  return { ready, done };
}

async function partB({ raw, schema }) {
  const sequelize = require('../libs/sequelize');
  sequelize.options.logging = false;
  const qi = sequelize.getQueryInterface();
  const svc = require('../Services/socialPublisherService');
  const worker = require('../workers/socialPublishWorker');
  const sel = (sql, r = {}) => sequelize.query(sql, { replacements: r, type: require('sequelize').QueryTypes.SELECT });
  const exec = (sql, r = {}) => sequelize.query(sql, { replacements: r });
  const mockFile = path.join(os.tmpdir(), `social-mock-${process.pid}.log`);
  fs.writeFileSync(mockFile, '');
  process.env.SOCIAL_MOCK_LOG = mockFile;
  const pubs = () => fs.readFileSync(mockFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let server;
  try {
    out(`\n▶ B0. Migraciones en schema temporal ${schema}`);
    const [{ sp }] = await sel('SELECT current_schema() AS sp');
    assert('conexión aislada en el schema temporal', sp === schema);
    await exec('CREATE TABLE app_settings (id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const m of ['20261018000001-create-creative-reviews', '20261019000001-create-social-publisher', '20261019000002-add-package-to-creative-reviews']) {
      await require(`../db/migrations/${m}`).up(qi);
    }
    await require('../db/migrations/20261019000002-add-package-to-creative-reviews').up(qi); // idempotente
    assert('migraciones aplicadas (y re-aplicables)', (await sel("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = :s AND table_name LIKE 'social_%'", { s: schema }))[0].n === 4);

    // Router real (webhook + endpoints admin)
    const dropiAuthPath = require.resolve(path.join(__dirname, '../integrations/dropi/dropiAuthService'));
    require.cache[dropiAuthPath] = { id: dropiAuthPath, filename: dropiAuthPath, loaded: true, exports: { completeManual2FA: async () => {} } };
    const express = require('express');
    require('../utils/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/ai', require('../routes/aiRouter'));
    app.use('/api/v1/social', require('../routes/socialRouter'));
    app.use((err, req, res, next) => { res.status(err.output?.statusCode || 500).json({ message: err.message }); next; }); // eslint-disable-line no-unused-expressions
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const jwt = require('jsonwebtoken');
    const adminTok = jwt.sign({ sub: 1, role: 'admin' }, process.env.JWT_SECRET);
    const custTok = jwt.sign({ sub: 2, role: 'customer' }, process.env.JWT_SECRET);
    const callApi = async (method, p, body, tok = adminTok) => {
      const r = await fetch(`${base}/social${p}`, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const ADMIN = Number(FAKE.ADMIN_ID);
    const sec = require('../libs/telegramSecurity');
    const callback = (action, ref, i = 0) => fetch(`${base}/ai/telegram/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': FAKE.SECRET },
      body: JSON.stringify({ update_id: 10 + i, callback_query: { id: `cq-${action}-${ref}-${i}`, from: { id: ADMIN }, message: { message_id: 777, chat: { id: ADMIN }, text: `Ref: ${ref}` }, data: sec.signCallbackData(action, ref) } }),
    }).then((r) => r.text());
    // Espera por sondeo (no sleep fijo) a que el webhook responda ESTE callback: tras la respuesta ya no cambia nada más.
    const settled = async (action, ref, i = 0) => {
      await callback(action, ref, i);
      const id = `cq-${action}-${ref}-${i}`;
      assert(`callback ${id} respondido`, await until(async () => tg.some((c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === id)));
    };
    const msg = (text, reply) => fetch(`${base}/ai/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': FAKE.SECRET }, body: JSON.stringify({ update_id: 99, message: { message_id: ++seq, chat: { id: ADMIN }, from: { id: ADMIN }, text, reply_to_message: reply } }) }).then((r) => r.text());
    const answers = (from) => tg.slice(from).filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text);
    const review = async (ref) => (await sel('SELECT * FROM creative_reviews WHERE ref = :ref', { ref }))[0];
    const postsOf = async (pieceId) => sel('SELECT * FROM social_posts WHERE piece_id = :id ORDER BY network', { id: pieceId });
    const setKey = (key, on) => exec('INSERT INTO app_settings (key, value) VALUES (:key, :v) ON CONFLICT (key) DO UPDATE SET value = :v', { key, v: on ? 'true' : 'false' });
    const setEnabled = (on) => setKey('social.publisher.enabled', on);
    const when = (min) => new Date(Date.now() + min * 60000).toISOString();

    out('\n▶ B1. Endpoints admin: auth y calendario');
    assert('sin JWT → 401', (await callApi('GET', '/status', null, null)).status === 401);
    assert('JWT de cliente → 403', (await callApi('GET', '/status', null, custTok)).status === 403);
    const camp = await callApi('POST', '/campaigns', { productId: 82, name: 'Fuente Pro octubre', objective: 'ventas', audience: 'dueños de mascotas Quito', concept: 'agua fresca', contentType: 'reel' });
    assert('crear campaña → 201', camp.status === 201 && camp.body.id > 0);
    const pieceBody = { ref: 'v82xsoc1', version: 1, videoSha256: VIDEO_SHA, videoUrl: VIDEO_URL, telegramFileId: 'FILEID-1', width: 1080, height: 1920, durationS: 14, bytes: VIDEO.length };
    const pc = await callApi('POST', `/campaigns/${camp.body.id}/pieces`, pieceBody);
    assert('crear pieza (ref + versión + sha256) → 201', pc.status === 201 && pc.body.video_sha256 === VIDEO_SHA);
    assert('misma ref + versión → 409', (await callApi('POST', `/campaigns/${camp.body.id}/pieces`, pieceBody)).status === 409);
    assert('M1: video_url sin el sha256 en la ruta → 400', (await callApi('POST', `/campaigns/${camp.body.id}/pieces`, { ...pieceBody, version: 8, videoUrl: 'https://firebasestorage.googleapis.com/v0/b/test/o/videos%2Fpiece.mp4' })).status === 400);
    assert('video_url de host no permitido → 400', (await callApi('POST', `/campaigns/${camp.body.id}/pieces`, { ...pieceBody, version: 9, videoUrl: 'https://evil.example/v.mp4' })).status === 400);
    const P1 = pc.body.id;
    const add = (pieceId, b) => callApi('POST', `/pieces/${pieceId}/posts`, b);
    const r1 = await add(P1, { network: 'mock', scheduledAt: when(-1), caption: 'Fuente Pro [mock-fail:temporary:2] #aynimar' });
    const r2 = await add(P1, { network: 'instagram', scheduledAt: when(-1), caption: 'Fuente Pro para IG #aynimar' });
    const r3 = await add(P1, { network: 'tiktok', scheduledAt: when(-1), caption: 'Fuente Pro para TikTok' });
    const r4 = await add(P1, { network: 'youtube', scheduledAt: when(-1), caption: 'Fuente Pro\nShort' });
    const r5 = await add(P1, { network: 'facebook', channel: 'manual', scheduledAt: '2026-10-25T19:00', caption: 'Fuente Pro para FB' });
    assert('5 publicaciones planificadas → 201', [r1, r2, r3, r4, r5].every((x) => x.status === 201), JSON.stringify([r1, r2, r3, r4, r5].map((x) => x.status)));
    assert('hora local 19:00 Guayaquil guardada como 00:00Z y zona por defecto', new Date(r5.body.scheduled_at).toISOString() === '2026-10-26T00:00:00.000Z' && r5.body.timezone === 'America/Guayaquil');
    assert('link UTM por red con utm_content = ref', r2.body.utm_link.includes('utm_source=instagram') && r2.body.utm_link.includes('utm_content=v82xsoc1') && r3.body.utm_link.includes('utm_source=tiktok'));
    assert('UTM por defecto: utm_campaign=social_c<id campaña>', r2.body.utm_link.includes(`utm_campaign=social_c${camp.body.id}&`));
    const utmFb = await callApi('PATCH', `/posts/${r5.body.id}`, { utmCampaign: 's1_oct26' });
    const pv2 = await callApi('POST', `/campaigns/${camp.body.id}/pieces`, { ...pieceBody, version: 2 });
    const r6 = await add(pv2.body.id, { network: 'instagram', channel: 'manual', scheduledAt: when(60), caption: 'v2', utmCampaign: 's1_oct26' });
    assert('UTM del calendario (utmCampaign) prevalece y mantiene utm_content=ref', utmFb.status === 200 && utmFb.body.utm_link.includes('utm_source=facebook') && utmFb.body.utm_link.includes('utm_campaign=s1_oct26&') && utmFb.body.utm_link.includes('utm_content=v82xsoc1') && !utmFb.body.utm_link.includes('social_c'), utmFb.body?.utm_link);
    assert('alta con utmCampaign → link con esa campaña', r6.status === 201 && r6.body.utm_link.includes('utm_source=instagram&utm_medium=organic&utm_campaign=s1_oct26&utm_content=v82xsoc1'), r6.body?.utm_link);
    assert('utmCampaign con caracteres no válidos → 400', (await callApi('PATCH', `/posts/${r5.body.id}`, { utmCampaign: 'a b&x=1' })).status === 400);
    assert('misma red dos veces → 409 (UNIQUE pieza-versión + red)', (await add(P1, { network: 'mock', scheduledAt: when(5), caption: 'x' })).status === 409);
    assert('TikTok por vía "api" → 400 (solo buffer o manual)', (await add(P1, { network: 'tiktok', channel: 'api', scheduledAt: when(5), caption: 'x' })).status === 400);
    let dup = null;
    try { await exec("INSERT INTO social_posts (piece_id, network, channel, scheduled_at, caption) VALUES (:p, 'instagram', 'buffer', now(), 'x')", { p: P1 }); } catch (e) { dup = e.parent?.code; }
    assert('BD: misma red por otra vía (api + buffer) → violación UNIQUE 23505', dup === '23505');
    assert('formato inválido (YouTube con <>) → 400 con errores', (await callApi('PATCH', `/posts/${r4.body.id}`, { caption: 'precio <b>' })).status === 400);
    const cal = await callApi('GET', '/calendar');
    assert('calendario lista las 5 publicaciones', cal.status === 200 && cal.body.filter((x) => x.piece_id === P1).length === 5);

    out('\n▶ B2. Revisión en Telegram ligada al paquete exacto');
    let n = tg.length;
    const rv = await callApi('POST', `/pieces/${P1}/review`);
    const sent = tg.slice(n);
    const REF = rv.body.ref;
    assert('review → 202 con ref y hash', rv.status === 202 && svc.isPackageRef(REF) && /^[0-9a-f]{64}$/.test(rv.body.packageHash));
    assert('A1: se SUBEN los bytes de video_url (sha256 = el aprobado), no el telegram_file_id de la API', sent[0].method === 'sendVideo' && sent[0].body.videoSha === VIDEO_SHA && sent[0].body.caption.includes(`Ref: ${REF}`) && !JSON.stringify(sent).includes('FILEID-1'));
    assert('A1: creative_reviews guarda el file_id que devuelve Telegram', /^TGFILE-/.test((await review(REF)).telegram_file_id || ''));
    const cards = sent.filter((c) => c.method === 'sendMessage' && c.body.text.startsWith('📅'));
    assert('una ficha por red con texto COMPLETO, fecha local y vía', cards.length === 5 && cards.some((c) => c.body.text.includes('Fuente Pro para IG #aynimar') && c.body.text.includes('INSTAGRAM · vía api')) && cards.some((c) => c.body.text.includes('TIKTOK · vía buffer')));
    const fin = sent.at(-1);
    assert('mensaje final con 3 botones firmados para ESTE ref', fin.body.reply_markup.inline_keyboard[0].length === 3 && fin.body.reply_markup.inline_keyboard[0].every((b) => sec.verifyCallbackQuery({ from: { id: ADMIN }, data: b.callback_data }).ref === REF));
    assert('fila pending con piece_id y package_hash', (await review(REF)).status === 'pending' && (await review(REF)).package_hash === rv.body.packageHash);

    out('\n▶ B3. J — callback x3 en paralelo, pausa, 2 workers + reintentos');
    n = tg.length;
    await Promise.all([callback('ap', REF, 1), callback('ap', REF, 2), callback('ap', REF, 3)]);
    await until(async () => answers(n).length === 3);
    const ans = answers(n);
    assert('3 callbacks simultáneos → 1 "✅ Aprobado" + 2 "Ya decidido"', ans.filter((a) => a === '✅ Aprobado').length === 1 && ans.filter((a) => a.startsWith('Ya decidido')).length === 2, JSON.stringify(ans));
    let ps = await postsOf(P1);
    assert('encoladas 4 (api/buffer), facebook manual → manual_required', ps.filter((p) => p.status === 'queued').length === 4 && ps.find((p) => p.network === 'facebook').status === 'manual_required');
    assert('kit manual enviado para facebook', tg.slice(n).some((c) => c.method === 'sendMessage' && c.body.text.includes('KIT DE PUBLICACIÓN') && c.body.text.includes('Fuente Pro para FB')));
    assert('historial: sent + approved', (await sel('SELECT event FROM social_approval_events WHERE piece_id = :p ORDER BY id', { p: P1 })).map((e) => e.event).join() === 'sent,approved');
    const events = (await sel('SELECT count(*)::int AS n FROM social_approval_events WHERE piece_id = :p', { p: P1 }))[0].n;

    // Pausa: interruptor OFF (por defecto) → el worker no reclama nada.
    const paused = await worker.runOnce({ notify: async () => {} });
    assert('pausa (social.publisher.enabled ausente) → 0 reclamadas, 0 publicadas', paused.length === 0 && pubs().length === 0);
    await setKey('social.enabled', true); // interruptor heredado de F2 ya en 'true'
    assert('M3: social.enabled (F2) = true NO enciende el publicador → 0 reclamadas', (await worker.runOnce({ notify: async () => {} })).length === 0 && pubs().length === 0);
    await setEnabled(false);
    assert('pausa (/stop = false) → 0 reclamadas', (await worker.runOnce({ notify: async () => {} })).length === 0);
    // 2 workers hijo arrancan y sondean EN PAUSA; al quitar la pausa compiten los 3 procesos.
    const childEnv = { ...process.env, SOCIAL_MOCK_LOG: mockFile };
    const w1 = spawnWorker(childEnv), w2 = spawnWorker(childEnv);
    await Promise.all([w1.ready, w2.ready]);
    assert('pausa con 2 workers hijo sondeando → 0 publicadas', pubs().length === 0 && (await postsOf(P1)).filter((p) => p.status === 'queued').length === 4);
    await msg('/reanudar'); // M3: el publicador solo se enciende con un /reanudar consciente
    assert('M3: /reanudar → social.publisher.enabled = true', await until(async () => svc.isEnabled()));

    const alerts = [];
    const notify = async (t) => { alerts.push(t); };
    const local = (async () => {
      const res = [];
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        res.push(...await worker.runOnce({ notify }));
        const [{ n: left }] = await sel("SELECT count(*)::int AS n FROM social_posts WHERE status IN ('queued','publishing')");
        if (!left) break;
        await sleep(30);
      }
      return res;
    })();
    // Callback tardío durante la publicación: no debe encolar nada nuevo.
    const late = callback('ap', REF, 4);
    const [c1, c2, mine] = await Promise.all([w1.done, w2.done, local, late]);
    assert('2 workers hijo terminan bien', c1.code === 0 && c2.code === 0, c1.out + c2.out);
    ps = await postsOf(P1);
    const byNet = Object.fromEntries(ps.map((p) => [p.network, p]));
    const all = pubs();
    const count = (net) => all.filter((x) => x.network === net).length;
    assert('J: mock publicada EXACTAMENTE 1 vez (tras 2 fallos temporales)', count('mock') === 1 && byNet.mock.status === 'published' && byNet.mock.attempts === 3, `pubs=${count('mock')} attempts=${byNet.mock.attempts}`);
    assert('J: instagram (Graph falso) EXACTAMENTE 1 media_publish', count('instagram') === 1 && byNet.instagram.status === 'published' && byNet.instagram.external_url.includes('instagram.com'));
    assert('J: tiktok (Buffer falso) EXACTAMENTE 1 createPost', count('tiktok') === 1 && byNet.tiktok.status === 'published');
    assert('J: total publicaciones = 3 (una por red autorizada)', all.length === 3, JSON.stringify(all));
    const workersUsed = new Set([...all.map((x) => x.pid)]);
    out(`     (procesos que publicaron: ${workersUsed.size}; resultados locales: ${JSON.stringify(mine)})`);
    assert('red no autorizada (youtube) → manual_required, 0 llamadas a Google', byNet.youtube.status === 'manual_required' && byNet.youtube.last_error.includes('no autorizada') && !api.some((c) => c.host === 'www.googleapis.com' && c.path.startsWith('/upload') && api.indexOf(c) > 40));
    assert('verificación registrada (verified_at) en mock / tiktok', byNet.mock.verified_at && byNet.tiktok.verified_at);
    assert('sha256 del vídeo descargado comprobado antes de publicar', api.some((c) => c.host === 'firebasestorage.googleapis.com'));
    assert('callback tardío → sin cambios en historial', (await sel('SELECT count(*)::int AS n FROM social_approval_events WHERE piece_id = :p', { p: P1 }))[0].n === events);
    await worker.runOnce({ notify });
    await settled('ap', REF, 5);
    await worker.runOnce({ notify });
    assert('re-ejecutar worker y callback otra vez → sigue 3 publicaciones', pubs().length === 3);
    assert('editar una publicación ya publicada → 409', (await callApi('PATCH', `/posts/${byNet.mock.id}`, { caption: 'otro' })).status === 409);

    // Pieza auxiliar: planifica 1 publicación mock y la envía a revisión.
    let k = 1;
    const piece = async (caption, extra = {}, postExtra = {}) => {
      const p = await svc.createPiece(camp.body.id, { ref: `v82xaux${k++}`, version: 1, videoSha256: VIDEO_SHA, videoUrl: VIDEO_URL, width: 1080, height: 1920, durationS: 14, bytes: VIDEO.length, ...extra });
      const post = await svc.addPost(p.id, { network: 'mock', scheduledAt: when(-1), caption, ...postExtra });
      const { ref } = await svc.sendForReview(p.id, 'test');
      return { id: p.id, post, ref };
    };
    const pubsOf = (postId) => pubs().filter((x) => x.postId === postId).length;

    out('\n▶ B4. Rechazo y cambios → 0 publicaciones');
    const R = await piece('pieza rechazada');
    await callback('rj', R.ref); await until(async () => (await review(R.ref)).status === 'rejected');
    const C = await piece('pieza con cambios');
    await callback('ch', C.ref); await until(async () => (await review(C.ref)).status === 'changes_requested');
    await worker.runOnce({ notify });
    assert('rechazo → posts en draft y 0 publicaciones', (await postsOf(R.id))[0].status === 'draft' && pubsOf(R.post.id) === 0);
    assert('cambios → posts en draft y 0 publicaciones', (await postsOf(C.id))[0].status === 'draft' && pubsOf(C.post.id) === 0);
    await settled('ap', R.ref, 9);
    assert('aprobar tras rechazar → no cambia nada', (await review(R.ref)).status === 'rejected' && (await postsOf(R.id))[0].status === 'draft');
    await msg('Cambia el precio del texto', { message_id: 777, from: { id: 111111, is_bot: true }, text: `Ref: ${C.ref}` });
    await msg('No encaja con la marca', { message_id: 778, from: { id: 111111, is_bot: true }, text: `❌ Ref: ${R.ref} rechazada.` });
    await until(async () => (await review(C.ref)).change_request && (await review(R.ref)).change_request);
    assert('observaciones registradas: cambios y motivo de rechazo', (await review(C.ref)).change_request === 'Cambia el precio del texto' && (await review(R.ref)).change_request === 'No encaja con la marca');
    assert('historial registra rejected / changes_requested', (await sel("SELECT event FROM social_approval_events WHERE piece_id IN (:a,:b) AND event IN ('rejected','changes_requested')", { a: R.id, b: C.id })).length === 2);

    out('\n▶ B5. Cambio tras aprobar → bloqueado');
    const E = await piece('texto aprobado');
    await setEnabled(false); // que no salga antes de editar
    await callback('ap', E.ref); await until(async () => (await review(E.ref)).status === 'approved');
    const ed = await callApi('PATCH', `/posts/${E.post.id}`, { caption: 'texto CAMBIADO tras aprobar' });
    assert('editar texto aprobado → 200 con approvalInvalidated', ed.status === 200 && ed.body.approvalInvalidated === true);
    assert('post vuelve a draft y la pieza queda invalidated', (await postsOf(E.id))[0].status === 'draft' && (await sel('SELECT approval_status FROM social_pieces WHERE id = :id', { id: E.id }))[0].approval_status === 'invalidated');
    await setEnabled(true);
    await worker.runOnce({ notify });
    assert('0 publicaciones de la pieza editada', pubsOf(E.post.id) === 0);
    await settled('ap', E.ref, 7);
    assert('botón antiguo tras el cambio → no re-aprueba', (await postsOf(E.id))[0].status === 'draft');

    const S = await piece('texto enviado');
    await svc.updatePost(S.post.id, { scheduledAt: when(30) }, 'test');
    n = tg.length;
    await callback('ap', S.ref); await until(async () => answers(n).length > 0);
    assert('cambio entre envío y aprobación → "El paquete cambió", nada encolado', answers(n)[0]?.includes('El paquete cambió') && (await postsOf(S.id))[0].status === 'draft' && (await review(S.ref)).status === 'pending');

    const T = await piece('texto íntegro');
    await setEnabled(false);
    await callback('ap', T.ref); await until(async () => (await review(T.ref)).status === 'approved');
    await exec('UPDATE social_posts SET caption = :c WHERE id = :id', { c: 'manipulado directo en BD', id: T.post.id });
    await setEnabled(true);
    alerts.length = 0;
    await worker.runOnce({ notify });
    let tp = (await postsOf(T.id))[0];
    assert('texto alterado en BD (saltándose la API) → worker lo bloquea, 0 publicaciones', tp.status === 'blocked' && tp.last_error.includes('cambió') && pubsOf(T.post.id) === 0);
    assert('alerta de bloqueo', alerts.some((a) => a.includes('Bloqueada')));

    out('\n▶ B6. Errores permanentes, inciertos, máximo de intentos y sha256');
    alerts.length = 0;
    const F = await piece('pieza [mock-fail:permanent]');
    const U = await piece('pieza [mock-fail:unknown]');
    const M = await piece('pieza [mock-fail:temporary:9]');
    const H_PATH = `/v0/b/test/o/h%2F${VIDEO_SHA}.mp4`;
    const H = await piece('pieza con vídeo alterado', { videoUrl: `https://firebasestorage.googleapis.com${H_PATH}` });
    for (const x of [F, U, M, H]) { await callback('ap', x.ref); await until(async () => (await review(x.ref)).status === 'approved'); }
    tampered.add(H_PATH); // el archivo cambia DESPUÉS de verificarse y aprobarse
    for (let i = 0; i < 40; i++) {
      await worker.runOnce({ notify });
      const [{ n: left }] = await sel("SELECT count(*)::int AS n FROM social_posts WHERE status = 'queued'");
      if (!left) break;
      await sleep(120);
    }
    const fp = (await postsOf(F.id))[0], up = (await postsOf(U.id))[0], mp = (await postsOf(M.id))[0], hp = (await postsOf(H.id))[0];
    assert('permanente → failed, 1 intento, error registrado', fp.status === 'failed' && fp.attempts === 1 && fp.last_error.includes('permanente'));
    assert('permanente → alerta "Fallo"', alerts.some((a) => a.includes('Fallo') && a.includes(`#${fp.id}`)));
    assert('incierto → manual_required sin reintento (1 intento)', up.status === 'manual_required' && up.attempts === 1 && alerts.some((a) => a.includes('Paso manual') && a.includes(`#${up.id}`)));
    assert('temporal persistente → failed al llegar a max_attempts (5)', mp.status === 'failed' && mp.attempts === 5, `${mp.status}/${mp.attempts}`);
    assert('sha256 del archivo distinto al aprobado → blocked', hp.status === 'blocked' && hp.last_error.includes('sha256'));
    assert('ninguna de ellas publicó', [fp, up, mp, hp].every((p) => pubsOf(p.id) === 0));

    out('\n▶ B7. Worker caído a mitad → manual_required (nunca reintento ciego)');
    const W = await piece('pieza interrumpida');
    await setEnabled(false);
    await callback('ap', W.ref); await until(async () => (await review(W.ref)).status === 'approved');
    await exec("UPDATE social_posts SET status = 'publishing', locked_by = 'muerto', locked_at = now() - interval '1 hour', attempts = 1 WHERE id = :id", { id: W.post.id });
    await setEnabled(true);
    alerts.length = 0;
    await worker.runOnce({ notify });
    const wp = (await postsOf(W.id))[0];
    assert('publishing caducado → manual_required + alerta, 0 publicaciones', wp.status === 'manual_required' && alerts.some((a) => a.includes('interrumpió')) && pubsOf(W.post.id) === 0);

    out('\n▶ B9. Correcciones de seguridad (A1, M2, M4, B3, B6)');
    // A1: si video_url ya no tiene los bytes del sha declarado, no se envía nada a revisión.
    const A_PATH = `/v0/b/test/o/a1%2F${VIDEO_SHA}.mp4`;
    const ap = await svc.createPiece(camp.body.id, { ref: 'v82xa1', version: 1, videoSha256: VIDEO_SHA, videoUrl: `https://firebasestorage.googleapis.com${A_PATH}`, telegramFileId: 'FILEID-OTRO-VIDEO', width: 1080, height: 1920, durationS: 14, bytes: VIDEO.length });
    await svc.addPost(ap.id, { network: 'mock', scheduledAt: when(-1), caption: 'a1' });
    tampered.add(A_PATH);
    n = tg.length;
    const a1 = await callApi('POST', `/pieces/${ap.id}/review`);
    assert('A1: vídeo cuyo sha256 no coincide → 409 y nada enviado a Telegram', a1.status === 409 && tg.length === n && (await sel('SELECT approval_status FROM social_pieces WHERE id = :id', { id: ap.id }))[0].approval_status === 'draft', `${a1.status}`);
    // M2: aprobado 7 h tarde → manual_required, no se publica al instante.
    alerts.length = 0;
    const L = await piece('pieza caducada', {}, { scheduledAt: when(-7 * 60) });
    await callback('ap', L.ref); await until(async () => (await review(L.ref)).status === 'approved');
    await worker.runOnce({ notify });
    const lp = (await postsOf(L.id))[0];
    assert('M2: retraso > 6 h respecto a scheduled_at → manual_required, 0 publicaciones', lp.status === 'manual_required' && lp.last_error.includes('retraso') && pubsOf(L.post.id) === 0 && alerts.some((a) => a.includes('retraso')));
    // M4: otra instancia marca manual_required mientras publicamos → se guarda external_id y se avisa.
    alerts.length = 0;
    const X = await piece('pieza lock perdido');
    await callback('ap', X.ref); await until(async () => (await review(X.ref)).status === 'approved');
    await worker.runOnce({ notify, fetchVideo: async (pc, d) => {
      const v = await worker.downloadVideo(pc.video_url, d);
      await exec("UPDATE social_posts SET status = 'manual_required', locked_by = NULL, locked_at = NULL WHERE id = :id", { id: X.post.id });
      return v;
    } });
    const xp = (await postsOf(X.id))[0];
    assert('M4: finish falla (lock perdido) → manual_required CON external_id + alerta, 1 sola publicación', xp.status === 'manual_required' && xp.external_id === `mock_${X.post.id}` && pubsOf(X.post.id) === 1 && alerts.some((a) => a.includes('lock había caducado')));
    // B3: mock rechazada en production.
    const envName = process.env.RAILWAY_ENVIRONMENT_NAME;
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    let b3 = null;
    try { await svc.addPost(ap.id, { network: 'mock', scheduledAt: when(5), caption: 'x' }); } catch (e) { b3 = e.status; } finally { process.env.RAILWAY_ENVIRONMENT_NAME = envName; }
    assert('B3: red mock en production → 400', b3 === 400);
    // B6: rango del calendario acotado.
    assert('B6: /calendar con rango > 92 días → 400; rango invertido → 400', (await callApi('GET', '/calendar?from=2026-01-01&to=2026-12-31')).status === 400 && (await callApi('GET', '/calendar?from=2026-12-01&to=2026-11-01')).status === 400);

    out('\n▶ B8. Panel y /estado');
    const st = await callApi('GET', '/status');
    const stJson = JSON.stringify(st.body);
    assert('panel: campañas → piezas → estado por red', st.status === 200 && st.body.campaigns[0].pieces.some((p) => p.posts.some((x) => x.network === 'instagram' && x.status === 'published')));
    assert('panel: credenciales como CONFIGURADO/NO CONFIGURADO, sin valores', st.body.networks.youtube.configured === 'NO CONFIGURADO' && st.body.networks.instagram.configured === 'CONFIGURADO' && ![FAKE.META, FAKE.BUFFER, FAKE.BOT_TOKEN].some((s) => stJson.includes(s)));
    n = tg.length;
    await msg('/estado');
    await until(async () => tg.slice(n).some((c) => c.method === 'sendMessage'));
    assert('/estado incluye la cola social y el interruptor del publicador', tg.slice(n).some((c) => c.method === 'sendMessage' && c.body.text.includes('Cola social:') && c.body.text.includes('published=') && c.body.text.includes('social.publisher.enabled): ON')));

    out('\n▶ B10. Autoaprobación orgánica (SOCIAL_AUTO_APPROVE_ORGANIC)');
    const oc = await svc.createCampaign({ productId: 82, name: 'v82 orgánico', contentType: 'organico' });
    const orgPiece = async (k2) => {
      const p = await svc.createPiece(oc.id, { ref: `v82xorg${k2}`, version: 1, videoSha256: VIDEO_SHA, videoUrl: VIDEO_URL, width: 1080, height: 1920, durationS: 14, bytes: VIDEO.length });
      const post = await svc.addPost(p.id, { network: 'mock', scheduledAt: when(-1), caption: `orgánico ${k2}`, utmCampaign: 'v82_oct26' });
      return { id: p.id, post };
    };
    const O1 = await orgPiece(1);
    const o1 = await svc.sendForReview(O1.id, 'test');
    assert('interruptor OFF (por defecto): campaña orgánica queda pending con botones', !o1.autoApproved && (await review(o1.ref)).status === 'pending' && tg.at(-1).body.reply_markup?.inline_keyboard?.[0]?.length === 3);
    process.env.SOCIAL_AUTO_APPROVE_ORGANIC = 'true';
    try {
      const NO = await piece('no orgánica con interruptor ON');
      assert('interruptor ON + campaña no orgánica → pending (requiere botón)', (await review(NO.ref)).status === 'pending');
      await setEnabled(false);
      const O2 = await orgPiece(2);
      n = tg.length;
      const o2 = await svc.sendForReview(O2.id, 'cto');
      const op = (await postsOf(O2.id))[0];
      const last = tg.at(-1);
      assert('interruptor ON + orgánica → aprobada y encolada (hash aprobado = hash enviado)', o2.autoApproved === true && o2.queued === 1 && (await review(o2.ref)).status === 'approved' && op.status === 'queued' && op.approved_hash === o2.packageHash);
      assert('Telegram recibe vídeo + ficha + aviso sin botones', tg.slice(n).some((c) => c.method === 'sendVideo') && last.body.text.includes('Auto-aprobado') && !last.body.reply_markup);
      assert('historial: sent + approved con actor auto:organico', (await sel('SELECT event, actor FROM social_approval_events WHERE piece_id = :p ORDER BY id', { p: O2.id })).map((e) => `${e.event}:${e.actor}`).join() === 'sent:cto,approved:auto:organico');
      assert('UTM orgánico con la campaña del calendario', op.utm_link.includes('utm_medium=organic&utm_campaign=v82_oct26&utm_content=v82xorg2'));
      assert('reenviar el paquete ya aprobado → 409 (no hay borradores)', (await callApi('POST', `/pieces/${O2.id}/review`)).status === 409);
      await worker.runOnce({ notify: async () => {} });
      assert('pausa global /stop → la autoaprobada no sale', (await postsOf(O2.id))[0].status === 'queued' && pubsOf(op.id) === 0);
      await setEnabled(true);
      await worker.runOnce({ notify: async () => {} });
      await worker.runOnce({ notify: async () => {} });
      assert('publicador ON → sale exactamente una vez', (await postsOf(O2.id))[0].status === 'published' && pubsOf(op.id) === 1);
    } finally { delete process.env.SOCIAL_AUTO_APPROVE_ORGANIC; }
  } finally {
    if (server) server.close();
    await sequelize.close().catch(() => {});
    await dropSchema(raw, schema).catch((e) => console._error('no se pudo borrar el schema temporal:', e.message));
    fs.rmSync(mockFile, { force: true });
  }
}

// ── Proceso worker hijo ──────────────────────────────────────────────────────
async function workerMain() {
  const sequelize = require('../libs/sequelize');
  sequelize.options.logging = false;
  const worker = require('../workers/socialPublishWorker');
  const { QueryTypes } = require('sequelize');
  const res = [];
  await sequelize.query('SELECT 1');
  console.log('READY');
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    res.push(...await worker.runOnce({ notify: async () => {} }));
    const [{ n }] = await sequelize.query("SELECT count(*)::int AS n FROM social_posts WHERE status IN ('queued','publishing')", { type: QueryTypes.SELECT });
    if (!n) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  console.log(JSON.stringify({ pid: process.pid, res }));
  await sequelize.close();
}

async function main() {
  // El schema temporal debe existir ANTES de cargar libs/sequelize (lee DATABASE_URL al importarse).
  const db = process.env.SOCIAL_TEST_DATABASE_URL ? await setupDb() : null;
  if (!db) process.env.DATABASE_URL = 'postgres://soctest:test@localhost:5432/never_connects';
  await partA();
  if (db) await partB(db);
  else out('\n▶ Parte B (Postgres) OMITIDA: define SOCIAL_TEST_DATABASE_URL (staging o local; nunca producción).');
  out('\n▶ Ausencia de secretos en logs');
  const all = logs.join('\n');
  assert('logs sin tokens ni secretos', ![FAKE.BOT_TOKEN, FAKE.SECRET, FAKE.META, FAKE.BUFFER, FAKE.YT_SECRET, 'FAKE-page-token', 'FAKE-yt-access'].some((x) => all.includes(x)));
  out(`\n${'─'.repeat(50)}\nSocial publisher tests: ${passed} passed, ${failed} failed\n`);
  if (failed) { console._error('Logs capturados:\n' + all.slice(-6000)); process.exit(1); }
  process.exit(0);
}

if (IS_WORKER) workerMain().then(() => process.exit(0), (err) => { console.error('worker hijo falló:', err.message); process.exit(1); });
else main().catch((err) => { console._error('Error inesperado en la suite:', err); process.exit(1); });
