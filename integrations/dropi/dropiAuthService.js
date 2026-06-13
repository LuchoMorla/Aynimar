'use strict';

const axios = require('axios');
const { getTokenFromDB, saveTokenToDB } = require('./dropiTokenService');

let _cachedToken    = process.env.DROPI_SESSION_TOKEN || '';
let _tokenExpiresAt = _cachedToken ? parseExp(_cachedToken) : 0;

function parseExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp ? payload.exp * 1000 : 0;
  } catch { return 0; }
}

function isExpired(token) {
  if (!token) return true;
  const exp = parseExp(token);
  return !exp || Date.now() >= exp - 5 * 60 * 1000;
}

async function loginWithCredentials() {
  const email    = process.env.DROPI_USER_EMAIL    || '';
  const password = process.env.DROPI_USER_PASSWORD || '';
  if (!email || !password) throw new Error('[Dropi] DROPI_USER_EMAIL / DROPI_USER_PASSWORD no configurados.');
  const { data } = await axios.post(
    'https://api.dropi.ec/api/login',
    { email, password, white_brand_id: 1, with_cdc: false },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Origin':       'https://app.dropi.ec',
        'Referer':      'https://app.dropi.ec/auth/login',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000,
    }
  );
  if (!data?.isSuccess) throw new Error(`[Dropi] Login fallido: ${data?.message ?? JSON.stringify(data)}`);
  const token = data.objects?.token ?? data.objects?.access_token ?? data.token ?? data.access_token;
  if (!token) throw new Error('[Dropi] Login exitoso pero no se encontró token en la respuesta.');
  return token;
}

/**
 * Returns a valid Dropi session token.
 * Priority order:
 *   1. In-memory cache (fast path — no DB round-trip on most requests)
 *   2. PostgreSQL app_settings (persists across process restarts / redeployments)
 *   3. Auto-login via DROPI_USER_EMAIL + DROPI_USER_PASSWORD (blocked by Dropi from datacenters, but tried anyway)
 *   4. DROPI_SESSION_TOKEN env var (static fallback — may be expired)
 */
async function getToken() {
  // 1. In-memory cache
  if (_cachedToken && !isExpired(_cachedToken)) return _cachedToken;

  // 2. PostgreSQL
  try {
    const dbToken = await getTokenFromDB();
    if (dbToken && !isExpired(dbToken)) {
      console.log('[Dropi] Token cargado desde BD.');
      _cachedToken    = dbToken;
      _tokenExpiresAt = parseExp(dbToken);
      return _cachedToken;
    }
    if (dbToken) console.log('[Dropi] Token en BD expirado — buscando alternativa...');
  } catch (dbErr) {
    console.warn('[Dropi] No se pudo leer token de BD:', dbErr.message);
  }

  // 3. Autologin
  const email    = process.env.DROPI_USER_EMAIL    || '';
  const password = process.env.DROPI_USER_PASSWORD || '';
  if (email && password) {
    try {
      console.log('[Dropi] Intentando autologin...');
      const fresh = await loginWithCredentials();
      _cachedToken    = fresh;
      _tokenExpiresAt = parseExp(fresh);
      try { await saveTokenToDB(fresh); } catch (_) {}
      console.log(`[Dropi] Autologin exitoso. Válido hasta: ${new Date(_tokenExpiresAt).toISOString()}`);
      return _cachedToken;
    } catch (err) {
      console.warn(`[Dropi] Autologin falló: ${err.message}`);
    }
  }

  // 4. Env var estática
  const staticToken = process.env.DROPI_SESSION_TOKEN || '';
  if (staticToken) {
    console.warn('[Dropi] Usando DROPI_SESSION_TOKEN de entorno (puede estar expirado).');
    _cachedToken = staticToken;
    return _cachedToken;
  }

  throw new Error(
    '[Dropi] No hay token válido. Usa POST /api/v1/import/dropi-token para guardar uno fresco.'
  );
}

function invalidateToken() {
  _cachedToken    = '';
  _tokenExpiresAt = 0;
}

module.exports = { getToken, invalidateToken };
