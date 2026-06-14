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
  const email    = process.env.DROPI_EMAIL;
  const password = process.env.DROPI_PASSWORD;

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

  // Inject TOTP code if 2FA secret is configured
  const secret2fa = process.env.DROPI_2FA_SECRET;
  if (secret2fa) {
    console.log('[Dropi Auth] Generando código 2FA de respaldo matemático...');
    const otp      = generateTOTP(secret2fa);
    const otpField = process.env.DROPI_2FA_FIELD || 'otp';
    loginPayload[otpField] = otp;
    console.log(`[Dropi Auth] Código 2FA generado para ventana actual (campo: "${otpField}").`);
  }

  let newToken;

  if (process.env.DROPI_WORKER_URL && process.env.DROPI_WORKER_KEY) {
    // Route through Cloudflare Worker to bypass WAF that blocks Railway datacenter IPs
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
    // Direct call — may be blocked by Cloudflare WAF from Railway IPs
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
