'use strict';

const { getTokenFromDB } = require('./dropiTokenService');

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
      console.log('[Dropi] Token cargado desde BD.');
      _cachedToken    = dbToken;
      _tokenExpiresAt = parseExp(dbToken);
      return _cachedToken;
    }
    if (dbToken) console.log('[Dropi] Token en BD expirado — buscando alternativa...');
  } catch (dbErr) {
    console.warn('[Dropi] No se pudo leer token de BD:', dbErr.message);
  }

  // 3. Env var estática de respaldo
  const staticToken = process.env.DROPI_SESSION_TOKEN || '';
  if (staticToken) {
    console.warn('[Dropi] Usando DROPI_SESSION_TOKEN de entorno (puede estar expirado).');
    _cachedToken = staticToken;
    return _cachedToken;
  }

  throw new Error('[Dropi] Sin token de sesión. Usa POST /api/v1/import/dropi-token para configurar uno.');
}

function invalidateToken() {
  _cachedToken    = '';
  _tokenExpiresAt = 0;
}

module.exports = { getToken, invalidateToken };
