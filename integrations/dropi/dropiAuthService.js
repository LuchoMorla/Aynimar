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

/**
 * Returns a valid Dropi session token.
 * Priority: 1. memory cache  2. PostgreSQL app_settings  3. DROPI_SESSION_TOKEN env var
 */
async function getToken() {
  // 1. In-memory cache
  if (_cachedToken && !isExpired(_cachedToken)) return _cachedToken;

  // 2. PostgreSQL
  try {
    const dbToken = await getTokenFromDB();
    if (dbToken && !isExpired(dbToken)) {
      console.log('[Dropi Auth] Token cargado desde BD.');
      _cachedToken    = dbToken;
      _tokenExpiresAt = parseExp(dbToken);
      return _cachedToken;
    }
    if (dbToken) console.log('[Dropi Auth] Token en BD expirado — buscando alternativa...');
  } catch (dbErr) {
    console.warn('[Dropi Auth] No se pudo leer token de BD:', dbErr.message);
  }

  // 3. Env var estática de respaldo
  const staticToken = process.env.DROPI_SESSION_TOKEN || '';
  if (staticToken) {
    console.warn('[Dropi Auth] Usando DROPI_SESSION_TOKEN de entorno (puede estar expirado).');
    _cachedToken = staticToken;
    return _cachedToken;
  }

  throw new Error('[Dropi] Sin token de sesión. Usa POST /api/v1/import/dropi-token para configurar uno.');
}

function invalidateToken() {
  _cachedToken    = '';
  _tokenExpiresAt = 0;
}

/**
 * Attempts to re-authenticate with Dropi using stored credentials.
 * Reads DROPI_EMAIL + DROPI_PASSWORD + DROPI_WHITE_BRAND_ID from env vars.
 * Routes through the Cloudflare Worker if DROPI_WORKER_URL is set (needed from Railway).
 * On success: saves fresh token to DB and updates in-memory cache.
 */
async function autoRefreshToken() {
  const email   = process.env.DROPI_EMAIL;
  const password = process.env.DROPI_PASSWORD;
  const brandId = Number(process.env.DROPI_WHITE_BRAND_ID) || 8;

  if (!email || !password) {
    throw new Error(
      'Sin credenciales para auto-login. ' +
      'Configura DROPI_EMAIL y DROPI_PASSWORD en Railway, o actualiza el token manualmente.'
    );
  }

  const loginPayload = { email, password, white_brand_id: brandId };
  let newToken;

  if (process.env.DROPI_WORKER_URL && process.env.DROPI_WORKER_KEY) {
    // Route through Worker to bypass Cloudflare WAF blocking Railway IPs
    const { data } = await axios.post(
      process.env.DROPI_WORKER_URL,
      {
        dropiToken: '',
        path:       '/api/users/login',
        method:     'POST',
        payload:    loginPayload,
      },
      { headers: { 'X-Worker-Key': process.env.DROPI_WORKER_KEY }, timeout: 20000 }
    );
    newToken = data?.token ?? data?.access_token ?? data?.data?.token ?? null;
  } else {
    // Direct call — may be blocked by Cloudflare from Railway datacenter IPs
    const { data } = await axios.post(
      `${process.env.DROPI_API_URL || 'https://api.dropi.ec'}/api/users/login`,
      loginPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Origin':       'https://app.dropi.ec',
          'Referer':      'https://app.dropi.ec/login',
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 15000,
      }
    );
    newToken = data?.token ?? data?.access_token ?? data?.data?.token ?? null;
  }

  if (!newToken) {
    throw new Error('Login a Dropi respondió OK pero no retornó token. Verifica las credenciales.');
  }

  await saveTokenToDB(newToken);
  _cachedToken    = newToken;
  _tokenExpiresAt = parseExp(newToken);
  console.log('[Dropi Auth] Token renovado y guardado en BD exitosamente.');
  return _cachedToken;
}

module.exports = { getToken, invalidateToken, autoRefreshToken };
