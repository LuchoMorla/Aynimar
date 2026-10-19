'use strict';
/* eslint-disable no-console */
/* global Response, Blob */
/**
 * Video Engine Test Suite
 *
 * Cero conexiones a DB, a Redis y a Telegram reales: global.fetch se intercepta.
 * El render real solo corre si FFMPEG_PATH apunta a un binario; si no, se salta
 * con aviso (CI sin ffmpeg no falla).
 *
 * Usage:
 *   FFMPEG_PATH=/ruta/ffmpeg node scripts/video-engine-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FAKE = { BOT_TOKEN: '111111:FAKE-bot-token-for-tests-only', SECRET: 'test_webhook-SECRET_abc123', ADMIN_ID: '987654321', JWT_SECRET: 'test-jwt-secret-only' };
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k.startsWith('RAILWAY_')) delete process.env[k];
delete process.env.REDIS_URL;
delete process.env.STORE_BASE_URL;
Object.assign(process.env, {
  DATABASE_URL: 'postgres://vtest:test@localhost:5432/vtest_never_connects',
  JWT_SECRET: FAKE.JWT_SECRET,
  TELEGRAM_BOT_TOKEN: FAKE.BOT_TOKEN,
  TELEGRAM_CHAT_ID: FAKE.ADMIN_ID,
  TELEGRAM_WEBHOOK_SECRET: FAKE.SECRET,
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  TELEGRAM_NONPROD_BOT_ID: '111111',
});

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}
async function rejects(fn, re) { try { await fn(); return false; } catch (e) { return re.test(e.message); } }

// ── Stub de red: imágenes de hosts permitidos + Telegram ─────────────────────
const realFetch = global.fetch;
let imageBytes = null;
const fetched = [];
const tgCalls = [];
global.fetch = async (url, opts = {}) => {
  const s = String(url);
  if (s.startsWith('https://api.telegram.org/')) {
    const form = opts.body;
    tgCalls.push({ method: s.split('/').pop(), form });
    return { ok: true, json: async () => ({ ok: true, result: { video: { file_id: 'FILEID123' } } }) };
  }
  if (s.startsWith('https://firebasestorage.googleapis.com/')) {
    fetched.push(s);
    return new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  throw new Error(`fetch inesperado en test: ${s}`);
};

const vs = require('../integrations/videoService');

async function main() {
  console.log('\n▶ videoService — funciones puras');
  assert('wrap corta por palabras ≤22', vs.wrap('Fuente de agua y comedero dos en uno para tu gato').split('\n').every((l) => l.length <= 22));
  assert('wrap no corta palabras largas', vs.wrap('Supercalifragilisticoespialidoso x', 10).split('\n')[0] === 'Supercalifragilisticoespialidoso');
  assert('wrap normaliza espacios', vs.wrap('  a   b  ') === 'a b');
  assert('shortName ≤40 sin cortar palabra', vs.shortName('Fuente de agua automática con filtro triple y comedero para gatos').length <= 40 && !/\s$/.test(vs.shortName('x '.repeat(40))));

  console.log('\n▶ Allowlist de hosts de imagen (SSRF)');
  assert('firebase https permitido', vs.isAllowedImageUrl('https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg'));
  assert('cloudfront de Dropi permitido', vs.isAllowedImageUrl('https://d39ru7awumhhs2.cloudfront.net/a.jpg'));
  assert('http (no https) rechazado', !vs.isAllowedImageUrl('http://firebasestorage.googleapis.com/a.jpg'));
  assert('host ajeno rechazado', !vs.isAllowedImageUrl('https://evil.example.com/a.jpg'));
  assert('subdominio engañoso rechazado', !vs.isAllowedImageUrl('https://firebasestorage.googleapis.com.evil.com/a.jpg'));
  assert('metadata interna rechazada', !vs.isAllowedImageUrl('http://169.254.169.254/latest/meta-data'));
  assert('URL basura rechazada', !vs.isAllowedImageUrl('no es url') && !vs.isAllowedImageUrl(null));
  assert('renderProductVideo con host no permitido → error antes de ffmpeg',
    await rejects(() => vs.renderProductVideo({ images: ['https://evil.example.com/a.jpg', 'https://evil.example.com/b.jpg'], texts: [], outPath: '/tmp/no.mp4', ffmpegPath: '/nonexistent' }), /no permitido/));
  assert('renderProductVideo con <2 imágenes → error', await rejects(() => vs.renderProductVideo({ images: ['https://firebasestorage.googleapis.com/a'], texts: [], outPath: 'x' }), /al menos 2/));
  const imgs = vs.productImages({ image: 'https://firebasestorage.googleapis.com/a.jpg', images: JSON.stringify(['https://firebasestorage.googleapis.com/a.jpg', 'https://evil.example.com/b.jpg', 'https://d39ru7awumhhs2.cloudfront.net/c.jpg']) });
  assert('productImages deduplica y filtra hosts', imgs.length === 2 && !imgs.some((u) => u.includes('evil')));
  assert('productImages tolera images inválido', vs.productImages({ image: 'https://firebasestorage.googleapis.com/a.jpg', images: '{roto' }).length === 1);

  console.log('\n▶ Plantillas V1/V2/V3');
  const d = { name: 'Fuente "Pro": agua 2 en 1', price: 24.9, benefit: 'Agua fresca: siempre limpia', nPhotos: 4 };
  for (const v of ['v1', 'v2', 'v3']) {
    const t = vs.buildTexts(v, d);
    assert(`${v}: incluye precio formateado $24.90`, t.some((x) => x.text.includes('$24.90')));
    assert(`${v}: incluye el beneficio literal`, t.some((x) => x.text === d.benefit));
    assert(`${v}: sin envío gratis/garantía/contra entrega`, !t.some((x) => /gratis|garant|contra\s*entrega/i.test(x.text)));
    assert(`${v}: tiempos crecientes dentro de la duración`, t.every((x, i) => x.from < x.to && (i === 0 || x.from >= t[i - 1].from)));
  }
  assert('variante desconocida → error', await rejects(async () => vs.buildTexts('v9', d), /variante/));
  assert('beneficio con "envío gratis" → error', await rejects(async () => vs.buildTexts('v1', { ...d, benefit: 'Envío gratis hoy' }), /no permitida/));
  assert('beneficio con "garantía" → error', await rejects(async () => vs.buildTexts('v1', { ...d, benefit: 'Con garantía de 1 año' }), /no permitida/));
  assert('beneficio > 60 caracteres → error', await rejects(async () => vs.buildTexts('v1', { ...d, benefit: 'x'.repeat(61) }), /60/));
  assert('precio inválido → error', await rejects(async () => vs.buildTexts('v1', { ...d, price: null }), /precio/));

  console.log('\n▶ Link UTM y ref');
  const ref = vs.newRef(82);
  assert('ref ≤32 y apto para callback_data', /^[A-Za-z0-9_-]{1,32}$/.test(ref), ref);
  const link = vs.storeLink(82, { network: 'tiktok', campaign: 'video_v1', ref });
  assert('link UTM correcto', link === `https://www.aynimar.com/store/82?utm_source=tiktok&utm_medium=organic&utm_campaign=video_v1&utm_content=${ref}`, link);
  const q = `utm_source=tiktok&utm_medium=organic&utm_campaign=video_v1&utm_content=${ref}`;
  const withBase = (b) => vs.storeLink(82, { network: 'tiktok', campaign: 'video_v1', ref }, b === undefined ? {} : { STORE_BASE_URL: b });
  const warn = console.warn; console.warn = () => {};
  try {
    assert('sin STORE_BASE_URL → tienda por defecto', withBase(undefined) === `https://www.aynimar.com/store/82?${q}`);
    assert('STORE_BASE_URL de staging → link a staging', withBase('https://staging.aynimar.com') === `https://staging.aynimar.com/store/82?${q}`);
    assert('STORE_BASE_URL con barra(s) final(es) → sin doble barra', withBase('https://staging.aynimar.com//') === `https://staging.aynimar.com/store/82?${q}`);
    assert('STORE_BASE_URL con subruta se respeta', withBase('https://x.vercel.app/tienda/') === `https://x.vercel.app/tienda/store/82?${q}`);
    assert('STORE_BASE_URL http → rechazada, por defecto', withBase('http://staging.aynimar.com') === `https://www.aynimar.com/store/82?${q}`);
    assert('STORE_BASE_URL basura / javascript: / con query → por defecto', ['no es url', 'javascript:alert(1)', 'https://a.com/?x=1', 'https://u:p@a.com'].every((b) => withBase(b) === `https://www.aynimar.com/store/82?${q}`));
  } finally { console.warn = warn; }

  console.log('\n▶ sendTelegramVideo — botones firmados');
  const { sendTelegramVideo } = require('../utils/telegramNotify');
  const sec = require('../libs/telegramSecurity');
  const tmpMp4 = path.join(os.tmpdir(), `vtest-${process.pid}.mp4`);
  fs.writeFileSync(tmpMp4, Buffer.from('fake mp4'));
  const sent = await sendTelegramVideo(tmpMp4, 'caption', ref);
  const call = tgCalls.at(-1);
  const kb = JSON.parse(call?.form?.get('reply_markup') || '{}').inline_keyboard?.[0] || [];
  assert('usa sendVideo y devuelve file_id', call?.method === 'sendVideo' && sent.ok && sent.fileId === 'FILEID123');
  assert('envía al chat admin', call.form.get('chat_id') === FAKE.ADMIN_ID);
  assert('3 botones ap/rj/ch verificables', kb.length === 3 && ['ap', 'rj', 'ch'].every((a, i) => {
    const v = sec.verifyCallbackQuery({ from: { id: Number(FAKE.ADMIN_ID) }, message: { chat: { id: Number(FAKE.ADMIN_ID) } }, data: kb[i].callback_data });
    return v.ok && v.action === a && v.ref === ref;
  }));
  assert('adjunta el vídeo', call.form.get('video') instanceof Blob);
  process.env.TELEGRAM_BOT_TOKEN = '222222:PROD-like';
  const n = tgCalls.length;
  assert('staging con token ajeno → no envía', !(await sendTelegramVideo(tmpMp4, 'c', ref)).ok && tgCalls.length === n);
  process.env.TELEGRAM_BOT_TOKEN = FAKE.BOT_TOKEN;
  fs.rmSync(tmpMp4, { force: true });

  console.log('\n▶ Endpoint POST /api/v1/ai/videos');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const jobs = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const origCreate = vs.createProductVideo;
  vs.createProductVideo = async (data) => { jobs.push(data); await gate; return {}; };
  const aiRouter = require('../routes/aiRouter');
  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', aiRouter);
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/ai/videos`;
  const post = async (body, token) => {
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const good = { productId: 82, variant: 'v2', benefit: 'Agua fresca todo el día' };
  const admin = jwt.sign({ sub: 1, role: 'admin' }, FAKE.JWT_SECRET);
  const errLog = console.error; console.error = () => {}; // logErrors del handler de errores
  try {
    assert('sin token → 401', (await post(good)).status === 401);
    assert('rol customer → 403', (await post(good, jwt.sign({ sub: 2, role: 'customer' }, FAKE.JWT_SECRET))).status === 403);
    assert('rol business_owner → 403', (await post(good, jwt.sign({ sub: 3, role: 'business_owner' }, FAKE.JWT_SECRET))).status === 403);
    assert('JWT con otra clave → 401', (await post(good, jwt.sign({ sub: 1, role: 'admin' }, 'otra'))).status === 401);
    assert('admin sin benefit → 400', (await post({ productId: 82, variant: 'v1' }, admin)).status === 400);
    assert('admin variante inválida → 400', (await post({ ...good, variant: 'v9' }, admin)).status === 400);
    assert('admin productId no numérico → 400', (await post({ ...good, productId: '82; DROP' }, admin)).status === 400);
    const ok = await post(good, admin);
    assert('admin válido → 202 con ref, cola en memoria', ok.status === 202 && ok.json.mode === 'memory' && /^v82x/.test(ok.json.ref), JSON.stringify(ok));
    await new Promise((r) => setTimeout(r, 20));
    assert('job recibe datos validados + network por defecto', jobs[0]?.productId === 82 && jobs[0]?.network === 'instagram' && jobs[0]?.ref === ok.json.ref);
    await post(good, admin); await post(good, admin);
    assert('cola llena (3 pendientes) → 429', (await post(good, admin)).status === 429);
    assert('serializado: solo 1 render en curso', jobs.length === 1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert('al terminar, procesa el siguiente', jobs.length >= 2);
  } finally {
    console.error = errLog;
    server.close();
    vs.createProductVideo = origCreate;
  }

  console.log('\n▶ Render real con ffmpeg (imagen sintética, texto con comillas/dos puntos/%)');
  const ff = process.env.FFMPEG_PATH;
  if (!ff || !fs.existsSync(ff)) {
    console.warn('  ⚠️  FFMPEG_PATH no definido o inexistente: se salta el render real.');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtest-'));
    try {
      const jpg = path.join(dir, 'src.jpg');
      const g = spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=800x800', '-frames:v', '1', jpg]);
      assert('imagen sintética generada con lavfi', g.status === 0, String(g.stderr));
      imageBytes = fs.readFileSync(jpg);
      const out = path.join(dir, 'out.mp4');
      const texts = [
        { text: "Fuente \"Pro\": l'agua 100% {limpia} \\ ; , [x]", from: 0, to: 3, pos: 'top', size: 66 },
        { text: '$24.90', from: 3, to: 999, pos: 'bottom', size: 130 },
      ];
      const t0 = Date.now();
      const r = await vs.renderProductVideo({
        images: ['https://firebasestorage.googleapis.com/a.jpg', 'https://firebasestorage.googleapis.com/b.jpg'],
        texts, outPath: out, ffmpegPath: ff,
      });
      console.log(`     render ${((Date.now() - t0) / 1000).toFixed(1)}s, ${(r.bytes / 1e6).toFixed(2)} MB`);
      assert('descargó por la ruta segura (2 imágenes)', fetched.length === 2);
      const probe = spawnSync(ff, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
      assert('salida 1080x1920 h264', /h264/.test(probe) && /1080x1920/.test(probe), probe.slice(-300));
      assert('duración 7 s', /Duration: 00:00:0[67]\./.test(probe));
      assert('tamaño < 50 MB (límite sendVideo)', r.bytes > 0 && r.bytes < 50e6);
      const dec = spawnSync(ff, ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
      assert('decodifica sin errores', dec.status === 0 && !dec.stderr.trim(), dec.stderr.slice(0, 300));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${'─'.repeat(50)}\nVideo engine tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('Error inesperado en la suite:', err); process.exit(1); });
