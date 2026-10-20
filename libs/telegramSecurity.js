'use strict';

/**
 * Telegram Security — F0 (endurecimiento del bot existente).
 *
 * Puro: sin DB, sin red. Solo lee el objeto `env` que recibe (por defecto
 * process.env) para poder probarse en scripts/telegram-security-test.js.
 *
 *  - Validación del header X-Telegram-Bot-Api-Secret-Token (fail-closed).
 *  - Aislamiento de entornos: fuera de production el bot SOLO se usa si su
 *    id coincide con TELEGRAM_NONPROD_BOT_ID (evita que staging/local use por
 *    error el token productivo, sustituya su webhook o escriba al CEO).
 *  - callback_data firmado (HMAC) para los futuros botones de aprobación.
 *
 * Nunca registra ni devuelve el token ni el secreto.
 */

const crypto = require('crypto');

// Telegram exige 1-256 caracteres A-Z a-z 0-9 _ - para secret_token.
const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

const KNOWN_UPDATE_TYPES = ['message', 'edited_message', 'channel_post', 'callback_query'];

// Acciones admitidas en callback_data: aprobar, rechazar, solicitar cambios,
// y 'cq' = opción de una pregunta del CTO (ref "<qid>_<n>", Services/ctoInboxService.js).
const CALLBACK_ACTIONS = ['ap', 'rj', 'ch', 'cq'];
// mk:<accion>:<ref>:<firma> — ref = id opaco de la autorización (F2).
const CALLBACK_RE = /^mk:([a-z]{2}):([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{16})$/;

/** Comparación en tiempo constante, también para longitudes distintas. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isProductionEnv(env = process.env) {
  return env.RAILWAY_ENVIRONMENT_NAME === 'production';
}

/** Id numérico del bot = parte anterior a ':' del token (no es secreto). */
function botIdFromToken(token) {
  const m = /^(\d+):/.exec(token || '');
  return m ? m[1] : null;
}

/**
 * Token del bot utilizable en ESTE entorno, o null.
 * production: igual que antes (TELEGRAM_BOT_TOKEN).
 * otro entorno: solo si el id del token == TELEGRAM_NONPROD_BOT_ID.
 */
function getTelegramToken(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (isProductionEnv(env)) return token;
  const expected = env.TELEGRAM_NONPROD_BOT_ID;
  if (!expected || botIdFromToken(token) !== String(expected)) return null;
  return token;
}

/** Razón (sin datos sensibles) por la que getTelegramToken devolvió null. */
function telegramDisabledReason(env = process.env) {
  if (!env.TELEGRAM_BOT_TOKEN) return 'TELEGRAM_BOT_TOKEN no configurado';
  if (getTelegramToken(env)) return null;
  return 'entorno no productivo: TELEGRAM_NONPROD_BOT_ID ausente o no coincide con el bot configurado';
}

/** true solo si hay secreto configurado y el header coincide. */
function isValidWebhookSecret(headerValue, env = process.env) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !headerValue) return false;
  return safeEqual(String(headerValue), expected);
}

/**
 * Cuerpo de setWebhook, o { error } si no debe registrarse.
 * allowed_updates solo se envía si TELEGRAM_ALLOWED_UPDATES está definido
 * (production sin esa variable conserva su configuración actual).
 */
function buildSetWebhookBody(webhookUrl, env = process.env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return { error: 'TELEGRAM_WEBHOOK_SECRET no configurado' };
  if (!WEBHOOK_SECRET_RE.test(secret)) return { error: 'TELEGRAM_WEBHOOK_SECRET con formato inválido (1-256 de A-Z a-z 0-9 _ -)' };

  const body = { url: webhookUrl, drop_pending_updates: false, secret_token: secret };
  if (env.TELEGRAM_ALLOWED_UPDATES) {
    const list = env.TELEGRAM_ALLOWED_UPDATES.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = list.filter((t) => !KNOWN_UPDATE_TYPES.includes(t));
    if (unknown.length) return { error: `TELEGRAM_ALLOWED_UPDATES contiene tipos no admitidos: ${unknown.join(',')}` };
    body.allowed_updates = list;
  }
  return { body };
}

/** chat/usuario administrador autorizado (mismo criterio que el 2FA actual). */
function getAdminChatId(env = process.env) {
  return env.TELEGRAM_OWNER_ID || env.TELEGRAM_CHAT_ID || null;
}

// La clave de firma se deriva del secreto del webhook: rotarlo invalida
// todos los botones antiguos (fail-safe).
function callbackKey(env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('aynimar-callback-v1').digest();
}

function callbackSignature(key, action, ref) {
  return crypto.createHmac('sha256', key).update(`${action}:${ref}`).digest('base64url').slice(0, 16);
}

/** callback_data firmado (≤64 bytes), o null si no hay clave o datos inválidos. */
function signCallbackData(action, ref, env = process.env) {
  const key = callbackKey(env);
  if (!key || !CALLBACK_ACTIONS.includes(action) || !/^[A-Za-z0-9_-]{1,32}$/.test(ref || '')) return null;
  return `mk:${action}:${ref}:${callbackSignature(key, action, ref)}`;
}

/**
 * Verifica un callback_query completo: origen (admin en su chat privado) y firma.
 * @returns {{ ok: true, action, ref } | { ok: false, reason }}
 */
function verifyCallbackQuery(cq, env = process.env) {
  const admin = getAdminChatId(env);
  if (!admin) return { ok: false, reason: 'admin_not_configured' };
  if (!cq || String(cq.from?.id) !== String(admin)) return { ok: false, reason: 'unauthorized_user' };
  if (cq.message && String(cq.message.chat?.id) !== String(admin)) return { ok: false, reason: 'unauthorized_chat' };

  const m = CALLBACK_RE.exec(typeof cq.data === 'string' ? cq.data : '');
  if (!m) return { ok: false, reason: 'malformed' };
  const [, action, ref, sig] = m;
  if (!CALLBACK_ACTIONS.includes(action)) return { ok: false, reason: 'unknown_action' };
  const key = callbackKey(env);
  if (!key || !safeEqual(sig, callbackSignature(key, action, ref))) return { ok: false, reason: 'bad_signature' };
  return { ok: true, action, ref };
}

/** Clave del header X-CTO-Key (hex) de GET /api/v1/ai/cto/inbox; null sin secreto. */
function ctoInboxKey(env = process.env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('aynimar-cto-inbox-v1').digest('hex');
}

/** true solo si hay secreto y el header X-CTO-Key coincide (tiempo constante). */
function isValidCtoKey(headerValue, env = process.env) {
  const expected = ctoInboxKey(env);
  return !!expected && !!headerValue && safeEqual(String(headerValue), expected);
}

/** Muestra solo los 4 últimos dígitos de un id. */
function maskId(id) {
  if (id == null || id === '') return null;
  const s = String(id);
  return s.length <= 4 ? '****' : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}

module.exports = {
  safeEqual,
  isProductionEnv,
  botIdFromToken,
  getTelegramToken,
  telegramDisabledReason,
  isValidWebhookSecret,
  buildSetWebhookBody,
  getAdminChatId,
  signCallbackData,
  verifyCallbackQuery,
  maskId,
  ctoInboxKey,
  isValidCtoKey,
  CALLBACK_ACTIONS,
  KNOWN_UPDATE_TYPES,
};
