'use strict';
/**
 * Adaptadores de publicación — interfaz común (ver docs/SOCIAL_PUBLISHER.md).
 *
 *   adapter = {
 *     envVars(network) → [nombres]                     solo nombres; nunca valores
 *     isConfigured(env, network) → bool
 *     publish({ post, piece, video }, ctx) → { externalId, url|null }   video = { url, sha256 }
 *     verify({ externalId, network }, ctx) → true | false | null(pendiente)
 *   }
 *   ctx = { fetch, env, sleep }
 *
 * Canal = vía de publicación de una red. UNA sola vía por red (SOCIAL_NETWORK_CHANNELS,
 * por defecto instagram:api, facebook:api, tiktok:buffer, youtube:api) y la BD lo
 * garantiza con UNIQUE (piece_id, network): imposible ir por API propia y por Buffer a la vez.
 *   api    → adaptador propio de la red (instagram, facebook, youtube; mock fuera de production)
 *   buffer → API de Buffer (tiktok; youtube si se elige esa vía)
 *   manual → nunca se publica solo: kit de publicación por Telegram
 * TikTok no tiene vía 'api': sin auditoría de TikTok una app propia solo publica en privado.
 *
 * Errores: PublishError.kind
 *   temporary → nada se publicó; se puede reintentar (429, 5xx antes del paso final, red caída)
 *   permanent → no se reintenta (4xx, formato, credencial inválida)
 *   unknown   → el paso FINAL pudo ejecutarse (timeout/5xx al publicar): NO se reintenta
 *               (evita duplicados); pasa a manual_required para verificación humana.
 * Tokens: solo en headers, nunca en URLs ni en mensajes de error.
 */
const { isProductionEnv } = require('../../libs/telegramSecurity');
const { PublishError, http } = require('./http');

const MB = 1024 * 1024;
// Límites de las docs oficiales (IG Reels, FB Video Reels API, TikTok, YouTube Shorts).
const LIMITS = {
  instagram: { minS: 3, maxS: 900, maxBytes: 300 * MB, captionMax: 2200, hashtagsMax: 30 },
  facebook:  { minS: 3, maxS: 90, maxBytes: 1024 * MB, captionMax: 63206, hashtagsMax: 30, minWidth: 540 },
  tiktok:    { minS: 3, maxS: 600, maxBytes: 4096 * MB, captionMax: 2200, hashtagsMax: null },
  youtube:   { minS: 1, maxS: 180, maxBytes: 2048 * MB, captionMax: 5000, hashtagsMax: 60, noAngleBrackets: true },
  mock:      { minS: 1, maxS: 600, maxBytes: 300 * MB, captionMax: 2200, hashtagsMax: 30 },
};
const NETWORKS = Object.keys(LIMITS);
const CHANNELS = ['api', 'buffer', 'manual'];
const DEFAULT_ROUTES = 'instagram:api,facebook:api,tiktok:buffer,youtube:api,mock:api';

const hashtagCount = (text) => (String(text).match(/#[\p{L}\p{N}_]+/gu) || []).length;

/** Lista de errores de formato (vacía = válido). 9:16 obligatorio en todas las redes. */
function validateFormat(network, piece, caption) {
  const l = LIMITS[network];
  if (!l) return [`red desconocida: ${network}`];
  const errs = [];
  const w = Number(piece.width), h = Number(piece.height);
  if (!(w > 0 && h > 0)) errs.push('dimensiones del vídeo desconocidas');
  else {
    if (Math.abs(w / h - 9 / 16) > 0.01) errs.push(`relación ${w}x${h} no es 9:16`);
    if (l.minWidth && w < l.minWidth) errs.push(`ancho mínimo ${l.minWidth}px`);
  }
  const d = Number(piece.durationS ?? piece.duration_s);
  if (!(d > 0)) errs.push('duración desconocida');
  else if (d < l.minS || d > l.maxS) errs.push(`duración ${d}s fuera de ${l.minS}-${l.maxS}s`);
  const bytes = Number(piece.bytes);
  if (bytes > l.maxBytes) errs.push(`tamaño ${Math.round(bytes / MB)}MB supera ${Math.round(l.maxBytes / MB)}MB`);
  const text = String(caption ?? '');
  if (!text.trim()) errs.push('texto vacío');
  if (text.length > l.captionMax) errs.push(`texto de ${text.length} caracteres supera ${l.captionMax}`);
  if (l.hashtagsMax != null && hashtagCount(text) > l.hashtagsMax) errs.push(`más de ${l.hashtagsMax} hashtags`);
  if (l.noAngleBrackets && /[<>]/.test(text)) errs.push('YouTube no admite < ni > en título/descripción');
  return errs;
}

/** Redes en la lista blanca SOCIAL_ALLOWED_NETWORKS (vacía por defecto = ninguna). mock nunca en production. */
function allowedNetworks(env = process.env) {
  return String(env.SOCIAL_ALLOWED_NETWORKS || '').split(',').map((s) => s.trim().toLowerCase())
    .filter((n) => NETWORKS.includes(n) && !(n === 'mock' && isProductionEnv(env)));
}

/** Vía automática de cada red: { red: 'api'|'buffer'|'manual' }. Entradas inválidas se ignoran. */
function networkRoutes(env = process.env) {
  const routes = Object.fromEntries(NETWORKS.map((n) => [n, 'manual']));
  for (const pair of `${DEFAULT_ROUTES},${env.SOCIAL_NETWORK_CHANNELS || ''}`.split(',')) {
    const [n, c] = pair.split(':').map((s) => (s || '').trim().toLowerCase());
    if (NETWORKS.includes(n) && CHANNELS.includes(c)) routes[n] = c;
  }
  if (routes.tiktok === 'api') routes.tiktok = 'buffer'; // sin vía propia (ver cabecera)
  return routes;
}

const API_ADAPTERS = {
  instagram: require('./instagram'),
  facebook: require('./facebook'),
  youtube: require('./youtube'),
  mock: require('./mock'),
};
const buffer = require('./buffer');

/** Adaptador para (red, canal), o null si esa combinación no publica sola. */
function getAdapter(network, channel) {
  if (channel === 'api') return API_ADAPTERS[network] || null;
  if (channel === 'buffer') return buffer.supports(network) ? buffer : null;
  return null;
}

/** Estado sin valores: { red: { channel, allowed, configured: CONFIGURADO|NO CONFIGURADO, envVars } }. */
function configStatus(env = process.env) {
  const allowed = allowedNetworks(env);
  const routes = networkRoutes(env);
  return Object.fromEntries(NETWORKS.map((n) => {
    const a = getAdapter(n, routes[n]);
    return [n, {
      channel: routes[n],
      allowed: allowed.includes(n),
      configured: a && a.isConfigured(env, n) ? 'CONFIGURADO' : 'NO CONFIGURADO',
      envVars: a ? a.envVars(n) : [],
    }];
  }));
}

module.exports = {
  PublishError, LIMITS, NETWORKS, CHANNELS, validateFormat, allowedNetworks, networkRoutes, hashtagCount, http, getAdapter, configStatus,
};
