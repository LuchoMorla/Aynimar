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
// windowOffset: 0 = current 30-s window, -1 = previous, +1 = next.
// Using ±1 tolerates clock skew and requests that span a window boundary.
function generateTOTP(base32Secret, windowOffset = 0) {
  const secret  = decodeBase32(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + windowOffset;

  const counterBuf = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low  = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low,  4);

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

// ── Telegram notification helper ─────────────────────────────────────────────

const _sendTelegram = async (text) => {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[Dropi Auth] Telegram no configurado (falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID).');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
  } catch (err) {
    console.error('[Dropi Auth] Error enviando mensaje Telegram:', err.message);
  }
};

// ── Dropi direct login — bypasses Worker (login is a public endpoint) ─────────

const _dropiLoginDirect = async (payload) => {
  const dropiBase = process.env.DROPI_API_URL || 'https://api.dropi.ec';
  try {
    const { data } = await axios.post(`${dropiBase}/api/users/login`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Origin':       'https://app.dropi.ec',
        'Referer':      'https://app.dropi.ec/login',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 30000,
    });
    console.log('[Dropi Auth] Login directo a Dropi exitoso (sin Worker).');
    return data;
  } catch (directErr) {
    const directStatus = directErr.response?.status;
    if (directStatus === 400 || directStatus === 401) throw directErr;
    // WAF block: fallback to Worker using stale env token as bearer placeholder.
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

  const brandId   = Number(process.env.DROPI_WHITE_BRAND_ID) || null;
  const secret2fa = process.env.DROPI_2FA_SECRET;
  const otpField  = process.env.DROPI_2FA_FIELD || 'otp';
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

  // Retry across TOTP windows to handle clock skew between Railway and Dropi.
  // Sequence: current window (0) → previous (-1) → next (+1). Each generates a fresh code.
  let loginData;
  let lastErr;

  const windows = secret2fa ? [0, -1, 1] : [null]; // null = no 2FA configured

  for (const windowOffset of windows) {
    const payload = { email, password };
    if (brandId) payload.white_brand_id = brandId;

    if (windowOffset !== null) {
      const otp = generateTOTP(secret2fa, windowOffset);
      payload[otpField] = otp;
      console.log(`[Dropi Auth] TOTP ventana ${windowOffset >= 0 ? '+' : ''}${windowOffset}: ${otp} (campo "${otpField}")`);
    }

    try {
      loginData = await _dropiLoginDirect(payload);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const body   = JSON.stringify(err.response?.data);
      console.error(`[Dropi Auth] Login HTTP ${status ?? 'ERR'} (ventana=${windowOffset ?? 'sin-2FA'}) — body: ${body}`);
      if (status !== 400) break; // 401/5xx won't improve with a different TOTP window
    }
  }

  if (lastErr) {
    // All automatic TOTP windows failed (400). Activate Telegram failover.
    if (secret2fa && lastErr.response?.status === 400) {
      const pendingErr = new Error(
        'Autenticación 2FA automática falló en todos los intervalos TOTP. ' +
        'Código 2FA manual requerido — el CEO ha sido notificado vía Telegram.'
      );
      pendingErr.code = 'DROPI_2FA_PENDING';
      await _sendTelegram(
        '⚠️ <b>Error de autenticación en Dropi.</b>\n\n' +
        'El código 2FA automático falló. Por favor, ingresa el código 2FA de tu app autenticadora:'
      );
      throw pendingErr;
    }
    throw lastErr;
  }

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

// ── Manual 2FA completion — called by Telegram webhook ────────────────────────

/**
 * Completes a Dropi login using a manually provided 2FA code (from Telegram).
 * Called by the Telegram webhook after the CEO sends the OTP code.
 */
async function completeManual2FA(code) {
  const email    = process.env.DROPI_EMAIL    || '';
  const password = process.env.DROPI_PASSWORD || '';
  if (!email || !password) throw new Error('Sin credenciales DROPI_EMAIL/DROPI_PASSWORD configuradas.');

  const brandId  = Number(process.env.DROPI_WHITE_BRAND_ID) || null;
  const otpField = process.env.DROPI_2FA_FIELD || 'otp';

  const payload = { email, password, [otpField]: String(code).trim() };
  if (brandId) payload.white_brand_id = brandId;

  // Clear stale DB token before attempting login.
  await saveTokenToDB('').catch(() => {});
  _cachedToken    = '';
  _tokenExpiresAt = 0;

  console.log(`[Dropi Auth] Completando login manual con código 2FA (campo: "${otpField}")...`);
  const loginData = await _dropiLoginDirect(payload);

  const newToken = loginData?.token ?? loginData?.access_token ?? loginData?.data?.token ?? null;
  if (!newToken) {
    throw new Error('Login con código manual completado pero Dropi no retornó token.');
  }

  await saveTokenToDB(newToken);
  _cachedToken    = newToken;
  _tokenExpiresAt = parseExp(newToken);
  console.log('[Dropi Auth] Token manual guardado en BD exitosamente.');
  return _cachedToken;
}

module.exports = { getToken, invalidateToken, autoRefreshToken, completeManual2FA };
