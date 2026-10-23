'use strict';
/** Error clasificado + fetch con clasificación (ver index.js). */

class PublishError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'PublishError';
    this.kind = kind;
  }
}

/**
 * fetch → JSON con clasificación de errores. `final: true` marca el paso que publica:
 * si su resultado es incierto (timeout, 5xx) el error es 'unknown', nunca 'temporary'.
 */
async function http(ctx, url, opts = {}, { final = false, step = '', timeoutMs = 60000 } = {}) {
  let resp;
  try {
    resp = await ctx.fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // Conexión rechazada / DNS: la petición no llegó. Timeout u otros: incierto en el paso final.
    const notSent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(`${err.code || ''} ${err.cause?.code || ''}`);
    throw new PublishError(final && !notSent ? 'unknown' : 'temporary', `${step}: ${err.name}`);
  }
  const text = await resp.text().catch(() => '');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (resp.ok) return { data, headers: resp.headers };
  const desc = String(data.error?.message || data.error_description || data.error?.code || resp.statusText || '').slice(0, 200);
  const msg = `${step}: HTTP ${resp.status} ${desc}`.trim();
  if (resp.status === 429) throw new PublishError('temporary', msg);
  if (resp.status >= 500) throw new PublishError(final ? 'unknown' : 'temporary', msg);
  throw new PublishError('permanent', msg);
}

module.exports = { PublishError, http };
