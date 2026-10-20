'use strict';
/**
 * Social publisher — calendario editorial, paquetes de aprobación y cola en Postgres.
 * Ver docs/SOCIAL_PUBLISHER.md. SQL explícito: la exclusión mutua (FOR UPDATE) y las
 * transiciones condicionadas son el núcleo de la garantía "una aprobación = una
 * publicación por red", así que no se esconden detrás del ORM.
 *
 * Paquete = pieza-versión (ref, version, sha256 del mp4) + sus publicaciones
 * (red, canal, fecha/hora, zona, texto, link UTM). Su sha256 es lo que se aprueba.
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const sequelize = require('../libs/sequelize');
const social = require('../integrations/social');
const { storeLink } = require('../integrations/videoService');
const { signCallbackData, getAdminChatId } = require('../libs/telegramSecurity');

const DEFAULT_TZ = 'America/Guayaquil';
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_VIDEO_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com'];

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function select(sql, replacements = {}, transaction) {
  return sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
}
/** UPDATE/INSERT … RETURNING → filas. */
async function returning(sql, replacements = {}, transaction) {
  const [rows] = await sequelize.query(sql, { replacements, transaction });
  return rows;
}

// ── Utilidades puras ─────────────────────────────────────────────────────────

function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Offset (ms) de una zona en un instante. */
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** "2026-10-20T19:00" (hora local de la cuenta) o ISO con zona/Z → Date UTC. */
function toUtc(input, tz = DEFAULT_TZ) {
  const s = String(input);
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return new Date(NaN);
  const guess = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6] || 0);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

function localTime(date, tz) {
  return new Intl.DateTimeFormat('es-EC', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
}

/** sha256 canónico del paquete: vídeo exacto + redes + canales + textos + horarios + links. */
function packageHash(piece, posts) {
  const canon = {
    ref: piece.ref, version: Number(piece.version), video_sha256: piece.video_sha256,
    posts: posts.map((p) => ({
      network: p.network, channel: p.channel, scheduled_at: new Date(p.scheduled_at).toISOString(),
      timezone: p.timezone, caption: p.caption, utm_link: p.utm_link || null,
    })).sort((a, b) => a.network.localeCompare(b.network)),
  };
  return sha256(JSON.stringify(canon));
}

function videoHosts(env = process.env) {
  return env.SOCIAL_VIDEO_HOSTS ? env.SOCIAL_VIDEO_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_VIDEO_HOSTS;
}

function isAllowedVideoUrl(url, env = process.env) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && videoHosts(env).includes(u.hostname);
  } catch { return false; }
}

const isPackageRef = (ref) => /^s\d+x/.test(String(ref || ''));
const newReviewRef = (pieceId) => `s${pieceId}x${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

// ── Lectura del paquete ──────────────────────────────────────────────────────

async function loadPackage(pieceId, t, { lock = false } = {}) {
  const [piece] = await select(`SELECT p.*, c.product_id FROM social_pieces p JOIN social_campaigns c ON c.id = p.campaign_id WHERE p.id = :id${lock ? ' FOR UPDATE OF p' : ''}`, { id: pieceId }, t);
  if (!piece) return { piece: null, posts: [] };
  const posts = await select('SELECT * FROM social_posts WHERE piece_id = :id ORDER BY network', { id: pieceId }, t);
  return { piece, posts };
}

function addEvent(t, { pieceId, reviewRef = null, event, hash = null, actor = null, note = null }) {
  return sequelize.query(
    'INSERT INTO social_approval_events (piece_id, review_ref, event, package_hash, actor, note) VALUES (:pieceId, :reviewRef, :event, :hash, :actor, :note)',
    { replacements: { pieceId, reviewRef, event, hash, actor: actor == null ? null : String(actor), note }, transaction: t }
  );
}

/**
 * Si el paquete pendiente/aprobado cambió: invalida la aprobación, anula los botones
 * (superseded_at) y saca de la cola lo que aún no salió. Debe llamarse con la pieza bloqueada.
 */
async function invalidateIfChanged(pieceId, t, actor) {
  const { piece, posts } = await loadPackage(pieceId, t);
  if (!['pending', 'approved'].includes(piece.approval_status)) return false;
  let ref = piece.approved_hash;
  if (piece.approval_status === 'pending') {
    const [r] = await select('SELECT package_hash FROM creative_reviews WHERE ref = :ref', { ref: piece.review_ref }, t);
    ref = r?.package_hash;
  }
  const hash = packageHash(piece, posts);
  if (ref === hash) return false;
  await sequelize.query("UPDATE social_pieces SET approval_status = 'invalidated', approved_hash = NULL, updated_at = now() WHERE id = :id", { replacements: { id: pieceId }, transaction: t });
  await sequelize.query('UPDATE creative_reviews SET superseded_at = now(), updated_at = now() WHERE piece_id = :id AND superseded_at IS NULL', { replacements: { id: pieceId }, transaction: t });
  await sequelize.query("UPDATE social_posts SET status = 'draft', approved_hash = NULL, approved_review_ref = NULL, next_attempt_at = NULL, updated_at = now() WHERE piece_id = :id AND status = 'queued'", { replacements: { id: pieceId }, transaction: t });
  await addEvent(t, { pieceId, reviewRef: piece.review_ref, event: 'invalidated', hash, actor, note: 'el paquete cambió tras enviarse/aprobarse: requiere nueva aprobación' });
  return true;
}

// ── Calendario (admin) ───────────────────────────────────────────────────────

async function createCampaign(v, userId) {
  const [row] = await returning(
    `INSERT INTO social_campaigns (product_id, name, objective, audience, concept, content_type, created_by)
     VALUES (:productId, :name, :objective, :audience, :concept, :contentType, :userId) RETURNING *`,
    { productId: v.productId ?? null, name: v.name, objective: v.objective ?? null, audience: v.audience ?? null, concept: v.concept ?? null, contentType: v.contentType ?? null, userId: userId ?? null }
  );
  return row;
}

function listCampaigns() {
  return select(`SELECT c.*, (SELECT count(*) FROM social_pieces p WHERE p.campaign_id = c.id)::int AS pieces
                 FROM social_campaigns c ORDER BY c.created_at DESC LIMIT 200`);
}

async function createPiece(campaignId, v) {
  if (!REF_RE.test(v.ref || '')) throw httpError(400, 'ref inválido');
  if (v.videoUrl && !isAllowedVideoUrl(v.videoUrl)) throw httpError(400, `video_url debe ser https en: ${videoHosts().join(', ')}`);
  const [c] = await select('SELECT id FROM social_campaigns WHERE id = :id', { id: campaignId });
  if (!c) throw httpError(404, 'campaña no encontrada');
  try {
    const [row] = await returning(
      `INSERT INTO social_pieces (campaign_id, ref, version, video_sha256, video_url, telegram_file_id, width, height, duration_s, bytes)
       VALUES (:campaignId, :ref, :version, :sha, :url, :fileId, :width, :height, :durationS, :bytes) RETURNING *`,
      { campaignId, ref: v.ref, version: v.version || 1, sha: String(v.videoSha256).toLowerCase(), url: v.videoUrl ?? null, fileId: v.telegramFileId ?? null, width: v.width ?? null, height: v.height ?? null, durationS: v.durationS ?? null, bytes: v.bytes ?? null }
    );
    return row;
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw httpError(409, 'esa ref + versión ya existe');
    throw err;
  }
}

/** utm_campaign del calendario/publicación si viene; social_c<id> solo por defecto. utm_content = ref. */
function utmLink(piece, network, campaign) {
  return piece.product_id ? storeLink(piece.product_id, { network, campaign: campaign || `social_c${piece.campaign_id}`, ref: piece.ref }) : null;
}

function checkPost(piece, { network, channel, caption, timezone }) {
  const route = social.networkRoutes()[network];
  if (!route) throw httpError(400, `red desconocida: ${network}`);
  if (channel !== route && channel !== 'manual') throw httpError(400, `${network} solo admite la vía configurada (${route}) o manual`);
  if (!isValidTimeZone(timezone)) throw httpError(400, 'zona horaria inválida');
  const errs = social.validateFormat(network, { width: piece.width, height: piece.height, durationS: piece.duration_s, bytes: piece.bytes }, caption);
  if (errs.length) throw httpError(400, `formato no válido para ${network}: ${errs.join('; ')}`, { errors: errs });
}

async function addPost(pieceId, v, actor) {
  return sequelize.transaction(async (t) => {
    const { piece } = await loadPackage(pieceId, t, { lock: true });
    if (!piece) throw httpError(404, 'pieza no encontrada');
    const timezone = v.timezone || DEFAULT_TZ;
    const channel = v.channel || social.networkRoutes()[v.network];
    checkPost(piece, { network: v.network, channel, caption: v.caption, timezone });
    const when = toUtc(v.scheduledAt, timezone);
    if (Number.isNaN(when.getTime())) throw httpError(400, 'scheduledAt inválido');
    const utm = utmLink(piece, v.network, v.utmCampaign);
    let row;
    try {
      [row] = await returning(
        `INSERT INTO social_posts (piece_id, network, channel, scheduled_at, timezone, caption, utm_link)
         VALUES (:pieceId, :network, :channel, :when, :timezone, :caption, :utm) RETURNING *`,
        { pieceId, network: v.network, channel, when, timezone, caption: v.caption, utm }, t
      );
    } catch (err) {
      // UNIQUE (piece_id, network): una sola publicación —y una sola vía— por red y versión.
      if (err.name === 'SequelizeUniqueConstraintError') throw httpError(409, `la pieza ya tiene una publicación para ${v.network}`);
      throw err;
    }
    await invalidateIfChanged(pieceId, t, actor);
    return row;
  });
}

async function updatePost(postId, v, actor) {
  return sequelize.transaction(async (t) => {
    const [cur] = await select('SELECT piece_id FROM social_posts WHERE id = :id', { id: postId }, t);
    if (!cur) throw httpError(404, 'publicación no encontrada');
    const { piece } = await loadPackage(cur.piece_id, t, { lock: true });
    const [post] = await select('SELECT * FROM social_posts WHERE id = :id FOR UPDATE', { id: postId }, t);
    if (['publishing', 'published'].includes(post.status)) throw httpError(409, `no se puede editar: estado ${post.status}`);
    const next = {
      caption: v.caption ?? post.caption,
      timezone: v.timezone ?? post.timezone,
      channel: v.channel ?? post.channel,
    };
    checkPost(piece, { network: post.network, ...next });
    const when = v.scheduledAt ? toUtc(v.scheduledAt, next.timezone) : new Date(post.scheduled_at);
    if (Number.isNaN(when.getTime())) throw httpError(400, 'scheduledAt inválido');
    const utm = v.utmCampaign ? utmLink(piece, post.network, v.utmCampaign) : post.utm_link;
    const [row] = await returning(
      `UPDATE social_posts SET caption = :caption, timezone = :timezone, channel = :channel, scheduled_at = :when, utm_link = :utm,
         next_attempt_at = CASE WHEN status = 'queued' THEN GREATEST(:when, now()) ELSE next_attempt_at END, updated_at = now()
       WHERE id = :id RETURNING *`,
      { ...next, when, utm, id: postId }, t
    );
    const invalidated = await invalidateIfChanged(cur.piece_id, t, actor);
    return { ...row, approvalInvalidated: invalidated };
  });
}

// ── Revisión por Telegram ────────────────────────────────────────────────────

function chunks(text, size = 3900) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Crea la revisión (creative_reviews con piece_id + package_hash) y envía a Telegram:
 * vídeo, una ficha por red (texto COMPLETO, fecha local, canal, link) y el mensaje
 * final con botones firmados. Reenviar anula los botones anteriores.
 */
async function sendForReview(pieceId, actor, { callTelegram = require('../utils/telegramNotify').callTelegram } = {}) {
  const { ref, piece, posts, hash } = await sequelize.transaction(async (t) => {
    const { piece, posts } = await loadPackage(pieceId, t, { lock: true });
    if (!piece) throw httpError(404, 'pieza no encontrada');
    if (!posts.some((p) => p.status === 'draft')) throw httpError(409, 'no hay publicaciones en borrador para revisar');
    for (const p of posts) checkPost(piece, p);
    const hash = packageHash(piece, posts);
    const ref = newReviewRef(pieceId);
    await sequelize.query('UPDATE creative_reviews SET superseded_at = now(), updated_at = now() WHERE piece_id = :id AND superseded_at IS NULL AND status = \'pending\'', { replacements: { id: pieceId }, transaction: t });
    await sequelize.query(
      `INSERT INTO creative_reviews (ref, product_id, network, telegram_file_id, status, piece_id, package_hash)
       VALUES (:ref, :productId, 'paquete', :fileId, 'pending', :pieceId, :hash)`,
      { replacements: { ref, productId: piece.product_id ?? null, fileId: piece.telegram_file_id ?? null, pieceId, hash }, transaction: t }
    );
    await sequelize.query("UPDATE social_pieces SET approval_status = 'pending', review_ref = :ref, approved_hash = NULL, updated_at = now() WHERE id = :id", { replacements: { ref, id: pieceId }, transaction: t });
    await addEvent(t, { pieceId, reviewRef: ref, event: 'sent', hash, actor });
    return { ref, piece, posts, hash };
  });

  const chat = getAdminChatId();
  const buttons = [['ap', 'Aprobar'], ['rj', 'Rechazar'], ['ch', 'Cambios']].map(([a, text]) => ({ text, callback_data: signCallbackData(a, ref) }));
  if (!chat || !buttons.every((b) => b.callback_data)) throw httpError(503, 'Telegram no configurado (chat admin o TELEGRAM_WEBHOOK_SECRET)');
  const video = piece.telegram_file_id || piece.video_url;
  const head = `Paquete para revisión\nRef: ${ref}\nPieza ${piece.ref} v${piece.version}\nVídeo sha256 ${piece.video_sha256.slice(0, 16)}…`;
  const v = video ? await callTelegram('sendVideo', { chat_id: chat, video, caption: head }) : await callTelegram('sendMessage', { chat_id: chat, text: `${head}\n(sin vídeo adjunto)` });
  if (!v) throw httpError(502, 'Telegram no aceptó el vídeo');
  for (const p of posts.filter((x) => x.status === 'draft')) {
    const card = `📅 ${p.network.toUpperCase()} · vía ${p.channel}\n${localTime(p.scheduled_at, p.timezone)} (${p.timezone})\n${p.utm_link || ''}\n\nTexto exacto:\n${p.caption}`;
    for (const part of chunks(card)) {
      if (!(await callTelegram('sendMessage', { chat_id: chat, text: part, reply_to_message_id: v.message_id }))) throw httpError(502, 'Telegram no aceptó la ficha');
    }
  }
  const nets = posts.filter((x) => x.status === 'draft').map((p) => `${p.network} ${localTime(p.scheduled_at, p.timezone)}`).join('\n');
  const final = await callTelegram('sendMessage', {
    chat_id: chat, reply_to_message_id: v.message_id, reply_markup: { inline_keyboard: [buttons] },
    text: `Ref: ${ref}\nPaquete ${hash.slice(0, 12)}\n${nets}\n\nAprobar publica EXACTAMENTE este vídeo, textos, redes y horarios. Cualquier cambio posterior anula la aprobación.`,
  });
  if (!final) throw httpError(502, 'Telegram no aceptó el mensaje de aprobación');
  await sequelize.query('UPDATE creative_reviews SET telegram_message_id = :mid WHERE ref = :ref', { replacements: { mid: final.message_id ?? null, ref } });
  return { ref, packageHash: hash, posts: posts.length };
}

const ACTION_STATUS = { ap: 'approved', rj: 'rejected', ch: 'changes_requested' };

/**
 * Decisión desde Telegram, atómica (fila de creative_reviews bloqueada FOR UPDATE):
 *  - solo pending y no superseded; callbacks repetidos o concurrentes → changed=false
 *  - aprobar recalcula el hash: si no coincide con el enviado → stale (nada se encola)
 *  - aprobar encola SOLO las publicaciones 'draft' de esa pieza (vía api/buffer) o las
 *    marca manual_required (vía manual). Rechazar / pedir cambios nunca encola.
 */
async function decidePackage(ref, action, adminId) {
  const status = ACTION_STATUS[action];
  if (!status) throw new Error(`acción desconocida: ${action}`);
  return sequelize.transaction(async (t) => {
    // Orden de bloqueo fijo (pieza → revisión), el mismo que en ediciones y reenvíos: sin deadlocks.
    const [hdr] = await select('SELECT piece_id FROM creative_reviews WHERE ref = :ref AND piece_id IS NOT NULL', { ref }, t);
    if (!hdr) return { changed: false, review: null };
    const { piece, posts } = await loadPackage(hdr.piece_id, t, { lock: true });
    const [row] = await select('SELECT ref, status, piece_id, package_hash, superseded_at FROM creative_reviews WHERE ref = :ref FOR UPDATE', { ref }, t);
    const review = { ref, status: row.status, pieceId: row.piece_id };
    if (row.status !== 'pending' || row.superseded_at) return { changed: false, review, superseded: !!row.superseded_at };
    const hash = packageHash(piece, posts);
    if (action === 'ap' && hash !== row.package_hash) {
      await sequelize.query('UPDATE creative_reviews SET superseded_at = now(), updated_at = now() WHERE ref = :ref', { replacements: { ref }, transaction: t });
      await sequelize.query("UPDATE social_pieces SET approval_status = 'invalidated', updated_at = now() WHERE id = :id", { replacements: { id: piece.id }, transaction: t });
      await addEvent(t, { pieceId: piece.id, reviewRef: ref, event: 'approve_rejected_stale', hash, actor: adminId, note: 'el paquete cambió después de enviarse' });
      return { changed: false, stale: true, review };
    }
    await sequelize.query('UPDATE creative_reviews SET status = :status, decided_at = now(), decided_by = :adminId, updated_at = now() WHERE ref = :ref', { replacements: { status, adminId, ref }, transaction: t });
    await sequelize.query('UPDATE social_pieces SET approval_status = :status, approved_hash = :ah, updated_at = now() WHERE id = :id', { replacements: { status, ah: action === 'ap' ? hash : null, id: piece.id }, transaction: t });
    await addEvent(t, { pieceId: piece.id, reviewRef: ref, event: status, hash, actor: adminId });
    review.status = status;
    if (action !== 'ap') return { changed: true, review, queued: [], manual: [] };
    const moved = await returning(
      `UPDATE social_posts SET status = CASE WHEN channel = 'manual' THEN 'manual_required' ELSE 'queued' END,
         approved_hash = :hash, approved_review_ref = :ref, attempts = 0, last_error = NULL,
         next_attempt_at = GREATEST(scheduled_at, now()), updated_at = now()
       WHERE piece_id = :id AND status = 'draft' RETURNING *`,
      { hash, ref, id: piece.id }, t
    );
    return { changed: true, review, queued: moved.filter((p) => p.status === 'queued'), manual: moved.filter((p) => p.status === 'manual_required') };
  });
}

// ── Panel ────────────────────────────────────────────────────────────────────

function calendar({ from, to } = {}) {
  return select(
    `SELECT s.id, s.network, s.channel, s.scheduled_at, s.timezone, s.status, s.attempts, s.last_error, s.external_url,
            p.id AS piece_id, p.ref, p.version, p.approval_status, c.id AS campaign_id, c.name AS campaign
       FROM social_posts s JOIN social_pieces p ON p.id = s.piece_id JOIN social_campaigns c ON c.id = p.campaign_id
      WHERE s.scheduled_at >= :from AND s.scheduled_at < :to ORDER BY s.scheduled_at`,
    { from: from || new Date(Date.now() - 7 * 864e5), to: to || new Date(Date.now() + 60 * 864e5) }
  );
}

async function isEnabled() {
  const [r] = await select("SELECT value FROM app_settings WHERE key = 'social.enabled'");
  return r?.value === 'true';
}

async function statusPanel() {
  const [campaigns, pieces, posts, counts, enabled] = await Promise.all([
    select('SELECT id, product_id, name, objective, audience, concept, content_type, created_at FROM social_campaigns ORDER BY created_at DESC LIMIT 50'),
    select('SELECT id, campaign_id, ref, version, video_sha256, approval_status, review_ref, created_at FROM social_pieces ORDER BY created_at DESC LIMIT 200'),
    select(`SELECT id, piece_id, network, channel, scheduled_at, timezone, status, attempts, max_attempts, next_attempt_at,
                   last_error, external_id, external_url, published_at, verified_at FROM social_posts ORDER BY scheduled_at DESC LIMIT 500`),
    select('SELECT network, status, count(*)::int AS n FROM social_posts GROUP BY network, status ORDER BY network, status'),
    isEnabled(),
  ]);
  const byPiece = new Map();
  for (const p of posts) (byPiece.get(p.piece_id) || byPiece.set(p.piece_id, []).get(p.piece_id)).push(p);
  const byCampaign = new Map();
  for (const p of pieces) (byCampaign.get(p.campaign_id) || byCampaign.set(p.campaign_id, []).get(p.campaign_id)).push({ ...p, posts: byPiece.get(p.id) || [] });
  return {
    publishing: enabled ? 'ON' : 'OFF (pausa global: /reanudar en Telegram)',
    networks: social.configStatus(),
    counts,
    campaigns: campaigns.map((c) => ({ ...c, pieces: byCampaign.get(c.id) || [] })),
  };
}

async function queueSummary() {
  const rows = await select('SELECT status, count(*)::int AS n FROM social_posts GROUP BY status');
  return rows.map((r) => `${r.status}=${r.n}`).join(' · ') || 'vacía';
}

module.exports = {
  DEFAULT_TZ, packageHash, toUtc, localTime, isValidTimeZone, isAllowedVideoUrl, isPackageRef, newReviewRef,
  loadPackage, createCampaign, listCampaigns, createPiece, addPost, updatePost, sendForReview, decidePackage,
  calendar, statusPanel, queueSummary, isEnabled, ACTION_STATUS,
};
