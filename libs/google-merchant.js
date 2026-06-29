'use strict';

/**
 * Google Merchant Center — Content API v2.1
 *
 * Autenticación: service account JWT (no OAuth interactivo).
 * Variables de entorno requeridas:
 *   GOOGLE_MERCHANT_ID              — ID numérico del Merchant Center
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL    — email del service account
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY — clave PEM (\\n literales o newlines reales)
 *
 * Variable opcional:
 *   GOOGLE_MERCHANT_TARGET_COUNTRY  — default 'CO'
 *   GOOGLE_MERCHANT_BASE_URL        — default 'https://www.aynimar.com'
 */

const jwt = require('jsonwebtoken');
const { logger } = require('./logger');

const SCOPE = 'https://www.googleapis.com/auth/content';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CONTENT_API = 'https://shoppingcontent.googleapis.com/content/v2.1';

let _tokenCache = null; // { token, expiresAt }

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Railway stores multiline secrets with literal \n — normalize both forms
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    throw new Error('[GoogleMerchant] GOOGLE_SERVICE_ACCOUNT_EMAIL / PRIVATE_KEY not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { scope: SCOPE, aud: TOKEN_URL, iss: email, iat: now, exp: now + 3600 },
    privateKey,
    { algorithm: 'RS256' }
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[GoogleMerchant] token exchange failed ${res.status}: ${body}`);
  }

  const { access_token, expires_in } = await res.json();
  _tokenCache = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

function mapProductToMerchant(product) {
  const country = process.env.GOOGLE_MERCHANT_TARGET_COUNTRY || 'CO';
  const baseUrl = (process.env.GOOGLE_MERCHANT_BASE_URL || 'https://www.aynimar.com').replace(/\/$/, '');

  const imageLink = Array.isArray(product.images) && product.images.length > 0
    ? product.images[0]
    : product.image;

  return {
    offerId:         String(product.id),
    title:           product.name,
    description:     product.description || product.name,
    link:            `${baseUrl}/store/${product.id}`,
    imageLink:       imageLink || null,
    contentLanguage: 'es',
    targetCountry:   country,
    channel:         'online',
    availability:    product.stock > 0 || product.stock === null ? 'in stock' : 'out of stock',
    price: {
      value:    String(Number(product.price).toFixed(2)),
      currency: 'COP',
    },
    // ponytail: brand/condition omitted — add when Merchant Center approval requires them
  };
}

/**
 * Syncs one Aynimar product to Google Merchant Center.
 * Returns the Google product resource on success.
 * Throws on auth or API error — caller decides how to handle.
 */
async function syncProductToMerchant(product) {
  const merchantId = process.env.GOOGLE_MERCHANT_ID;
  if (!merchantId) {
    throw new Error('[GoogleMerchant] GOOGLE_MERCHANT_ID not configured');
  }

  const token = await getAccessToken();
  const payload = mapProductToMerchant(product);

  const url = `${CONTENT_API}/${merchantId}/products`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();

  if (!res.ok) {
    logger.warn('[GoogleMerchant] sync failed', {
      productId: product.id,
      status:    res.status,
      errors:    body?.error?.errors,
    });
    throw new Error(`[GoogleMerchant] API error ${res.status}: ${body?.error?.message}`);
  }

  logger.info('[GoogleMerchant] product synced', {
    productId:      product.id,
    merchantOfferId: body.id,
  });

  return body;
}

/**
 * Lightweight auth check — fetches the merchant account metadata.
 * No product data involved. Returns { merchantId, websiteUrl, name } on success.
 */
async function pingMerchant() {
  const merchantId = process.env.GOOGLE_MERCHANT_ID;
  if (!merchantId) throw new Error('[GoogleMerchant] GOOGLE_MERCHANT_ID not configured');

  const token = await getAccessToken();
  const res = await fetch(`${CONTENT_API}/${merchantId}/accounts/${merchantId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`[GoogleMerchant] ping failed ${res.status}: ${body?.error?.message}`);
  }

  return {
    merchantId:  body.id,
    name:        body.name,
    websiteUrl:  body.websiteUrl,
    adultContent: body.adultContent,
  };
}

/**
 * Validates one product against Google Merchant Center requirements
 * WITHOUT sending it. Returns a detailed pre-flight report.
 *
 * Google Content API v2.1 required fields reference:
 * https://support.google.com/merchants/answer/7052112
 */
function validateProductForMerchant(product) {
  const payload = mapProductToMerchant(product);
  const issues   = [];
  const warnings = [];

  // ── Required fields ────────────────────────────────────────────────────────
  if (!payload.offerId)
    issues.push({ field: 'offerId', reason: 'Missing product ID', fix: 'El producto no tiene ID — no debería ocurrir, revisa la BD' });

  if (!payload.title || payload.title.length < 1)
    issues.push({ field: 'title', reason: 'Title is required', fix: 'Edita el campo "name" del producto en la BD' });
  else if (payload.title.length > 150)
    issues.push({ field: 'title', reason: `Title too long (${payload.title.length}/150 chars)`, fix: `Recorta el nombre a máximo 150 caracteres. Valor actual: "${payload.title.slice(0, 60)}…"` });
  else if (payload.title.length < 10)
    warnings.push({ field: 'title', reason: 'Title under 10 chars — low relevance in Shopping', fix: 'Amplía el nombre del producto con marca o descripción corta' });

  if (!payload.description || payload.description.length < 1)
    issues.push({ field: 'description', reason: 'Description is required', fix: 'Edita el campo "description" del producto en el Dashboard' });
  else if (payload.description.length > 5000)
    issues.push({ field: 'description', reason: 'Description exceeds 5000 chars', fix: `Recorta la descripción a máximo 5000 caracteres (actual: ${payload.description.length})` });
  else if (payload.description.length < 20)
    warnings.push({ field: 'description', reason: 'Description very short — add product details', fix: 'Añade al menos 20 caracteres de descripción para mayor visibilidad en Google Shopping' });

  if (!payload.link || !payload.link.startsWith('http'))
    issues.push({ field: 'link', reason: 'Product URL must start with http/https', fix: `URL generada: "${payload.link}" — revisa GOOGLE_MERCHANT_BASE_URL en Railway` });

  if (!payload.imageLink)
    issues.push({ field: 'imageLink', reason: 'At least one image is required', fix: 'El producto no tiene imagen. Sube una imagen en el Dashboard o edita el campo "image" en la BD' });
  else if (!payload.imageLink.startsWith('https'))
    issues.push({ field: 'imageLink', reason: 'Image URL must use HTTPS (Google requirement)', fix: `La imagen usa HTTP. Cambia la URL a HTTPS: "${payload.imageLink}"` });

  const priceNum = parseFloat(payload.price?.value);
  if (!priceNum || priceNum <= 0)
    issues.push({ field: 'price', reason: 'Price must be > 0', fix: 'Edita el campo "price" del producto — no puede ser 0 ni nulo' });
  else if (priceNum < 1000)
    warnings.push({ field: 'price', reason: `Price ${payload.price.currency} ${payload.price.value} — confirm currency is correct (expected COP)`, fix: 'Si el precio es correcto en COP, ignora esta advertencia. Si usas otra moneda, ajusta el mapeo en google-merchant.js' });

  if (!['in stock', 'out of stock', 'preorder', 'backorder'].includes(payload.availability))
    issues.push({ field: 'availability', reason: `Invalid availability value: "${payload.availability}"`, fix: 'Revisa el campo "stock" del producto — debe ser un número o null' });

  // ── Recommended fields ─────────────────────────────────────────────────────
  if (!payload.brand)
    warnings.push({ field: 'brand', reason: 'brand not set — required for most categories in Google Shopping', fix: 'Añade marca al producto. Puede ser "Aynimar" como marca propia si no hay fabricante externo' });

  if (!payload.condition)
    warnings.push({ field: 'condition', reason: 'condition not set — Google defaults to "new"; add if refurbished', fix: 'Si el producto es nuevo, no se requiere acción. Si es reacondicionado, agrega condition: "refurbished" en google-merchant.js' });

  return {
    valid:    issues.length === 0,
    issues,
    warnings,
    payload,
    summary: issues.length === 0
      ? `✅ Product #${product.id} passes all required validations${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`
      : `❌ Product #${product.id} has ${issues.length} blocking issue${issues.length > 1 ? 's' : ''} — fix before syncing`,
  };
}

module.exports = { syncProductToMerchant, pingMerchant, validateProductForMerchant };
