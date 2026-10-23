'use strict';
/* eslint-disable no-console */
/**
 * Worker de publicación social — cola en Postgres (sin Redis). Ver docs/SOCIAL_PUBLISHER.md.
 *
 * Garantía: una publicación aprobada sale COMO MUCHO una vez por (pieza-versión, red):
 *  - UNIQUE (piece_id, network) en BD: no puede existir una segunda fila para esa red.
 *  - Reclamo atómico: UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) pasa la fila
 *    queued → publishing en una sola sentencia; N workers nunca reclaman la misma fila.
 *    El mismo UPDATE exige app_settings social.enabled = 'true' (pausa global /stop).
 *  - Toda transición posterior va condicionada a status='publishing' AND locked_by=<este worker>.
 *  - Solo los errores 'temporary' (la plataforma no creó nada) vuelven a 'queued' con backoff
 *    exponencial y tope max_attempts. 'unknown' (pudo publicarse) y un worker caído a mitad
 *    (publishing caducado) pasan a manual_required: se verifica a mano, nunca se reintenta solo.
 *  - Antes de publicar: hash del paquete == hash aprobado, red en lista blanca, adaptador
 *    configurado, formato válido y sha256 del mp4 descargado == el aprobado.
 * Se arranca solo si SOCIAL_ALLOWED_NETWORKS tiene alguna red (por defecto: no arranca).
 */
const crypto = require('crypto');
const os = require('os');
const sequelize = require('../libs/sequelize');
const social = require('../integrations/social');
const { PublishError } = require('../integrations/social/http');
const svc = require('../Services/socialPublisherService');

const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`.slice(0, 64);
const MB = 1024 * 1024;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Descarga el mp4 (solo hosts permitidos, con tope) y calcula su sha256. */
async function downloadVideo(url, { fetch = global.fetch, env = process.env } = {}) {
  if (!url || !svc.isAllowedVideoUrl(url, env)) throw new PublishError('permanent', 'video_url ausente o de host no permitido');
  const max = num(env.SOCIAL_MAX_VIDEO_BYTES, 300 * MB);
  let r;
  try { r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) }); } catch (err) { throw new PublishError('temporary', `descarga del vídeo: ${err.name}`); }
  if (!r.ok) throw new PublishError(r.status >= 500 || r.status === 429 ? 'temporary' : 'permanent', `descarga del vídeo: HTTP ${r.status}`);
  if (Number(r.headers.get('content-length')) > max) throw new PublishError('permanent', 'vídeo demasiado grande');
  const buffer = Buffer.from(await r.arrayBuffer());
  if (buffer.length > max) throw new PublishError('permanent', 'vídeo demasiado grande');
  return { url, buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

function defaultDeps() {
  return {
    env: process.env,
    fetch: global.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchVideo: (piece, deps) => downloadVideo(piece.video_url, deps),
    notify: (text) => require('../utils/telegramNotify').sendTelegramNotification(text),
    workerId: WORKER_ID,
  };
}

/** queued → publishing, atómico; null si no hay nada vencido o la publicación está en pausa. */
async function claimNext(workerId) {
  const [rows] = await sequelize.query(`
    UPDATE social_posts SET status = 'publishing', locked_at = now(), locked_by = :w, attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM social_posts
        WHERE status = 'queued' AND next_attempt_at <= now()
          AND EXISTS (SELECT 1 FROM app_settings WHERE key = :key AND value = 'true')
        ORDER BY next_attempt_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
       AND status = 'queued'
    RETURNING *`, { replacements: { w: workerId, key: svc.PUBLISHER_KEY } });
  return rows[0] || null;
}

/** Transición final condicionada a que la fila siga siendo de este worker. */
async function finish(post, workerId, status, fields = {}) {
  const sets = Object.keys(fields).map((k) => `${k} = :${k}`).join(', ');
  const [rows] = await sequelize.query(
    `UPDATE social_posts SET status = :status, locked_at = NULL, locked_by = NULL, updated_at = now()${sets ? `, ${sets}` : ''}
      WHERE id = :id AND status = 'publishing' AND locked_by = :w RETURNING id`,
    { replacements: { ...fields, status, id: post.id, w: workerId } }
  );
  return rows.length === 1;
}

const label = (post) => `${esc(post.network)} · publicación #${post.id}`;

async function processPost(post, deps) {
  const { workerId, notify, env } = deps;
  const { piece, posts } = await svc.loadPackage(post.piece_id);
  const block = async (why) => {
    await finish(post, workerId, 'blocked', { last_error: why });
    await notify(`⛔ <b>Bloqueada</b> ${label(post)}: ${esc(why)}. No se publicó.`);
    return 'blocked';
  };
  const manual = async (why) => {
    await finish(post, workerId, 'manual_required', { last_error: why });
    await notify(`🖐 <b>Paso manual requerido</b> ${label(post)}: ${esc(why)}`);
    return 'manual_required';
  };

  if (!piece || piece.approval_status !== 'approved' || !post.approved_hash || piece.approved_hash !== post.approved_hash) return block('la aprobación ya no es válida');
  if (svc.packageHash(piece, posts) !== post.approved_hash) return block('el paquete cambió después de aprobarse: requiere nueva aprobación');
  if (!svc.urlHasSha(piece.video_url, piece.video_sha256)) return block('video_url no está direccionada por su sha256');
  // M2: nunca publicar fuera del horario aprobado (botón aprobado tarde o /reanudar tras una pausa larga).
  const lateMs = Date.now() - new Date(post.scheduled_at).getTime();
  if (lateMs > num(env.SOCIAL_MAX_LATE_MS, 6 * 3600000)) return manual(`retraso de ${Math.round(lateMs / 60000)} min respecto a la hora aprobada (SOCIAL_MAX_LATE_MS): publicar a mano o reprogramar`);
  if (!social.allowedNetworks(env).includes(post.network)) return manual(`red ${post.network} no autorizada (SOCIAL_ALLOWED_NETWORKS)`);
  const adapter = social.getAdapter(post.network, post.channel);
  if (!adapter || social.networkRoutes(env)[post.network] !== post.channel) return manual(`vía ${post.channel} no habilitada para ${post.network}`);
  if (!adapter.isConfigured(env, post.network)) return manual(`credenciales de ${post.network} NO CONFIGURADAS`);
  const errs = social.validateFormat(post.network, { width: piece.width, height: piece.height, durationS: piece.duration_s, bytes: piece.bytes }, post.caption);
  if (errs.length) {
    await finish(post, workerId, 'failed', { last_error: `formato: ${errs.join('; ')}`.slice(0, 1000) });
    await notify(`❌ <b>Fallo</b> ${label(post)}: formato no válido (${esc(errs.join('; '))}).`);
    return 'failed';
  }

  const ctx = { fetch: deps.fetch, env, sleep: deps.sleep };
  try {
    const video = await deps.fetchVideo(piece, deps);
    if (video.sha256 !== piece.video_sha256) return block('el archivo de vídeo no coincide con el sha256 aprobado');
    const res = await adapter.publish({ post, piece, video }, ctx);
    const fields = { external_id: String(res.externalId), external_url: res.url || null };
    if (!(await finish(post, workerId, 'published', { ...fields, published_at: new Date(), last_error: null }))) {
      // M4: otra instancia nos quitó la fila (lock caducado → manual_required) mientras publicábamos.
      // Salió en la red: se conserva el id externo para la verificación manual.
      await sequelize.query("UPDATE social_posts SET external_id = :external_id, external_url = :external_url, published_at = now(), updated_at = now() WHERE id = :id AND status = 'manual_required'", { replacements: { ...fields, id: post.id } });
      await notify(`⚠️ <b>Publicada, pero el lock había caducado</b> ${label(post)} (id ${esc(fields.external_id)}). Queda en manual_required: verifica en la red.`);
      return 'published_lock_lost';
    }
    let verified = null;
    try { verified = await adapter.verify({ externalId: String(res.externalId), network: post.network }, ctx); } catch (err) { console.warn(`[Social] verificación de #${post.id} falló: ${err.message}`); }
    if (verified === true) await sequelize.query('UPDATE social_posts SET verified_at = now() WHERE id = :id', { replacements: { id: post.id } });
    console.log(`[Social] #${post.id} ${post.network} publicada (${res.externalId}) verificada=${verified}`);
    await notify(`✅ <b>Publicada</b> ${label(post)}${res.url ? `\n${esc(res.url)}` : ''}\nVerificación: ${verified === true ? 'OK' : verified === false ? '⚠️ la plataforma no la confirma: revisar' : 'pendiente'}`);
    return 'published';
  } catch (err) {
    const kind = err instanceof PublishError ? err.kind : 'unknown'; // error inesperado: no arriesgar un duplicado
    const msg = String(err.message || err.name).slice(0, 1000);
    console.warn(`[Social] #${post.id} ${post.network} intento ${post.attempts}/${post.max_attempts} → ${kind}: ${msg}`);
    if (kind === 'temporary' && post.attempts < post.max_attempts) {
      const delay = Math.min(num(env.SOCIAL_RETRY_BASE_MS, 60000) * 2 ** (post.attempts - 1), 3600000);
      await finish(post, workerId, 'queued', { last_error: msg, next_attempt_at: new Date(Date.now() + delay) });
      return 'retry';
    }
    if (kind === 'unknown') return manual(`resultado incierto (${msg}); verifica en la red si se publicó. No se reintenta para no duplicar`);
    await finish(post, workerId, 'failed', { last_error: msg });
    await notify(`❌ <b>Fallo</b> ${label(post)} tras ${post.attempts} intento(s): ${esc(msg)}`);
    return 'failed';
  }
}

/** publishing con lock caducado (worker caído a mitad) → manual_required, nunca reintento ciego. */
async function recoverStale(deps) {
  const [rows] = await sequelize.query(`
    UPDATE social_posts SET status = 'manual_required', locked_at = NULL, locked_by = NULL, updated_at = now(),
           last_error = 'worker interrumpido durante la publicación: verificar manualmente'
     WHERE status = 'publishing' AND locked_at < now() - (:ms || ' milliseconds')::interval RETURNING id, network`,
  { replacements: { ms: String(num(deps.env.SOCIAL_LOCK_TIMEOUT_MS, 30 * 60000)) } });
  for (const p of rows) await deps.notify(`🖐 <b>Paso manual requerido</b> ${label(p)}: el worker se interrumpió durante la publicación. Verifica en la red si salió.`);
  return rows.length;
}

/** Publicadas sin verificar (p. ej. Buffer aún enviando): reintenta la verificación. */
async function verifyPending(deps) {
  const rows = await sequelize.query(
    `SELECT * FROM social_posts WHERE status = 'published' AND verified_at IS NULL AND published_at > now() - interval '2 days'
      ORDER BY published_at LIMIT 10`, { type: require('sequelize').QueryTypes.SELECT });
  for (const post of rows) {
    const adapter = social.getAdapter(post.network, post.channel);
    if (!adapter || !adapter.isConfigured(deps.env, post.network)) continue;
    let v = null;
    try { v = await adapter.verify({ externalId: post.external_id, network: post.network }, { fetch: deps.fetch, env: deps.env, sleep: deps.sleep }); } catch { continue; }
    if (v === true) await sequelize.query('UPDATE social_posts SET verified_at = now() WHERE id = :id', { replacements: { id: post.id } });
    if (v === false) {
      await sequelize.query("UPDATE social_posts SET status = 'manual_required', last_error = 'la plataforma informa error tras la entrega', updated_at = now() WHERE id = :id AND status = 'published'", { replacements: { id: post.id } });
      await deps.notify(`🖐 <b>Paso manual requerido</b> ${label(post)}: la plataforma informa error tras la entrega.`);
    }
  }
}

/** Un ciclo: recupera bloqueos caducados, publica lo vencido (máx. `limit`) y verifica pendientes. */
async function runOnce(overrides = {}, { limit = 20 } = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  await recoverStale(deps);
  const results = [];
  for (let i = 0; i < limit; i++) {
    const post = await claimNext(deps.workerId);
    if (!post) break;
    results.push(await processPost(post, deps));
  }
  await verifyPending(deps);
  return results;
}

let timer = null;
function start() {
  if (timer) return;
  const nets = social.allowedNetworks();
  if (!nets.length) {
    console.log('[Social] worker no iniciado: SOCIAL_ALLOWED_NETWORKS vacío (ninguna red autorizada).');
    return;
  }
  const every = num(process.env.SOCIAL_WORKER_INTERVAL_MS, 30000);
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (err) { console.error(`[Social] ciclo del worker falló: ${err.name} ${err.message}`); } finally { running = false; }
  }, every);
  timer.unref();
  console.log(`[Social] worker ${WORKER_ID} cada ${every} ms · redes autorizadas: ${nets.join(',')}`);
}

module.exports = { start, runOnce, claimNext, processPost, recoverStale, downloadVideo, WORKER_ID };
