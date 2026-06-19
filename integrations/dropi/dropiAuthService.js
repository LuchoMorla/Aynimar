'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const { getTokenFromDB, saveTokenToDB } = require('./dropiTokenService');

// ── In-memory token cache ─────────────────────────────────────────────────────

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

// ── TOTP (RFC 6238) — native crypto, no external deps ────────────────────────

/**
 * Decodes a base32 string (RFC 4648) into a Buffer.
 * Handles both uppercase/lowercase, ignores '=' padding and spaces/dashes.
 */
function decodeBase32(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean    = str.toUpperCase().replace(/[\s\-=]/g, '');
  let bits  = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generates a 6-digit TOTP code from a base32 secret (RFC 6238 / Google Authenticator compatible).
 * Uses 30-second window and SHA-1 HMAC (standard for most 2FA implementations).
 *
 * @param {string} base32Secret — the seed Dropi gives when enabling 2FA (e.g. "JBSWY3DPEHPK3PXP")
 * @returns {string} 6-digit code, zero-padded (e.g. "042317")
 */
function generateTOTP(base32Secret) {
  const secret  = decodeBase32(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / 30);

  // Counter as 8-byte big-endian buffer
  const counterBuf = Buffer.alloc(8);
  // JS bitwise ops are 32-bit, so split into high/low words
  const high = Math.floor(counter / 0x100000000);
  const low  = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low,  4);

  // HMAC-SHA1
  const hmac   = crypto.createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff)
  ) % 1_000_000;

  return String(code).padStart(6, '0');
}

// ── Public auth API ───────────────────────────────────────────────────────────

/**
 * Returns a valid Dropi session token.
 * Priority: 1. memory cache  2. PostgreSQL app_settings  3. DROPI_SESSION_TOKEN env var
 */
async function getToken() {
  if (_cachedToken && !isExpired(_cachedToken)) return _cachedToken;

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
 * Re-authenticates with Dropi using env-var credentials.
 *
 * Required env vars:
 *   DROPI_EMAIL          — Dropi account email
 *   DROPI_PASSWORD       — Dropi account password
 *
 * Optional env vars:
 *   DROPI_WHITE_BRAND_ID — brand/store ID (defaults to 8 if not set)
 *   DROPI_2FA_SECRET     — base32 TOTP seed from Dropi's 2FA setup screen
 *   DROPI_2FA_FIELD      — payload field name for the OTP (default: "otp")
 *   DROPI_WORKER_URL     — Cloudflare Worker URL (needed from Railway, which is blocked by Dropi WAF)
 *   DROPI_WORKER_KEY     — Worker auth key
 */
async function autoRefreshToken() {
  // Canonical vars are DROPI_EMAIL / DROPI_PASSWORD.
  // Fall back to DROPI_USER_EMAIL / DROPI_USER_PASSWORD so the system keeps
  // working while duplicate Railway variables are cleaned up from the dashboard.
  const email    = process.env.DROPI_EMAIL    || process.env.DROPI_USER_EMAIL    || '';
  const password = process.env.DROPI_PASSWORD || process.env.DROPI_USER_PASSWORD || '';

  if (!email || !password) {
    throw new Error(
      'Sin credenciales para auto-login. ' +
      'Configura DROPI_EMAIL y DROPI_PASSWORD en Railway, o actualiza el token manualmente.'
    );
  }

  const brandId = Number(process.env.DROPI_WHITE_BRAND_ID) || null;

  // Build base login payload
  const loginPayload = { email, password };
  if (brandId) loginPayload.white_brand_id = brandId;

  // Inject TOTP code — try DROPI_2FA_FIELD first, then common Dropi field names.
  // The 2FA probe order: explicit config → otp → totp → code → token_2fa
  const secret2fa = process.env.DROPI_2FA_SECRET;
  const OTP_FIELD_CANDIDATES = process.env.DROPI_2FA_FIELD
    ? [process.env.DROPI_2FA_FIELD]
    : ['otp', 'totp', 'code', 'token_2fa'];
  let resolvedOtpField = OTP_FIELD_CANDIDATES[0];

  if (secret2fa) {
    console.log('[Dropi Auth] Generando código 2FA de respaldo matemático...');
    const otp = generateTOTP(secret2fa);
    loginPayload[resolvedOtpField] = otp;
    console.log(`[Dropi Auth] Código 2FA generado para ventana actual (campo: "${resolvedOtpField}").`);
  }

  let newToken;

  // Clear the stale DB token so the system is forced into a clean login.
  try {
    await saveTokenToDB('');
    _cachedToken    = '';
    _tokenExpiresAt = 0;
    console.log('[Dropi Auth] Token expirado eliminado de BD. Iniciando login limpio...');
  } catch (clearErr) {
    console.warn('[Dropi Auth] No se pudo limpiar el token de BD:', clearErr.message);
  }

  // Login MUST bypass the Worker — the Worker requires a valid dropiToken in
  // the request body, which we don't have yet (that's why we're logging in).
  // Strategy: try direct call to Dropi first; if WAF blocks it, fall back to
  // Worker using the stale env token as a placeholder (Worker only checks presence).
  const dropiBase = process.env.DROPI_API_URL || 'https://api.dropi.ec';

  const _doLogin = async (payload) => {
    // Primary: direct call — correct for a public /login endpoint, no Bearer needed.
    try {
      const { data } = await axios.post(
        `${dropiBase}/api/users/login`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/json',
            'Origin':       'https://app.dropi.ec',
            'Referer':      'https://app.dropi.ec/login',
            'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          timeout: 30000,
        }
      );
      console.log('[Dropi Auth] Login directo a Dropi exitoso (sin Worker).');
      return data;
    } catch (directErr) {
      const directStatus = directErr.response?.status;
      // 400/401 from Dropi = wrong credentials/payload — do NOT fall back, these won't improve.
      if (directStatus === 400 || directStatus === 401) throw directErr;

      // WAF block (403/503) or network error: try through Worker using stale token as placeholder.
      const placeholder = process.env.DROPI_SESSION_TOKEN || 'dropi-login-bypass';
      console.warn(`[Dropi Auth] Login directo falló (${directStatus ?? directErr.code}) — intentando via Worker...`);

      if (!process.env.DROPI_WORKER_URL || !process.env.DROPI_WORKER_KEY) throw directErr;

      const { data } = await axios.post(
        process.env.DROPI_WORKER_URL,
        { dropiToken: placeholder, path: '/api/users/login', method: 'POST', payload },
        { headers: { 'X-Worker-Key': process.env.DROPI_WORKER_KEY }, timeout: 30000 }
      );
      console.log('[Dropi Auth] Login via Worker completado.');
      return data;
    }
  };

  // Attempt login — if 400 and 2FA is involved, probe each field name in sequence.
  let loginData;
  let lastErr;

  const attemptsToTry = secret2fa
    ? [...OTP_FIELD_CANDIDATES.map((f) => ({ field: f })), { field: null }] // + fallback without OTP
    : [{ field: null }];

  for (const { field } of attemptsToTry) {
    const payload = { email, password };
    if (brandId) payload.white_brand_id = brandId;

    if (secret2fa && field) {
      payload[field] = generateTOTP(secret2fa); // fresh TOTP per attempt (30-s window)
      if (field !== resolvedOtpField) {
        console.log(`[Dropi Auth] Probando campo 2FA alternativo: "${field}"`);
      }
    } else if (secret2fa && !field) {
      console.warn('[Dropi Auth] Último intento — login sin campo 2FA.');
    }

    try {
      loginData = await _doLogin(payload);
      if (field && field !== resolvedOtpField) {
        console.warn(`[Dropi Auth] ✓ Login exitoso con campo 2FA "${field}". ` +
          `Configura DROPI_2FA_FIELD=${field} en Railway para evitar los reintentos.`);
      } else if (!field && secret2fa) {
        console.warn('[Dropi Auth] ✓ Login exitoso SIN 2FA — verifica si la cuenta tiene ' +
          '2FA activo en Dropi; si no, elimina DROPI_2FA_SECRET de Railway.');
      }
      lastErr = null;
      break; // success — exit the probe loop
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const body   = JSON.stringify(err.response?.data);
      console.error(`[Dropi Auth] Login HTTP ${status ?? 'ERR'} (campo="${field ?? 'ninguno'}") — body: ${body}`);
      if (status !== 400) break; // only retry 400s — 401/5xx are not field-name issues
    }
  }

  if (lastErr) throw lastErr;

  newToken = loginData?.token ?? loginData?.access_token ?? loginData?.data?.token ?? null;

  if (!newToken) {
    throw new Error(
      'Dropi respondió OK al login pero no retornó token. ' +
      'Verifica las credenciales y, si tienes 2FA activo, configura DROPI_2FA_SECRET.'
    );
  }

  await saveTokenToDB(newToken);
  _cachedToken    = newToken;
  _tokenExpiresAt = parseExp(newToken);
  console.log('[Dropi Auth] Token renovado y guardado en BD exitosamente.');
  return _cachedToken;
}

module.exports = { getToken, invalidateToken, autoRefreshToken };
