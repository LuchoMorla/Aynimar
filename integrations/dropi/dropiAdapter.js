'use strict';

const axios    = require('axios');
const FormData = require('form-data');
const { getToken, invalidateToken, autoRefreshToken } = require('./dropiAuthService');

const WOO_JWT        = process.env.WOO_CONSUMER_SECRET || '';
const DROPI_API_BASE = process.env.DROPI_API_URL       || 'https://api.dropi.ec';

// IS_MOCK sólo se activa con la flag explícita DROPI_MOCK=true.
// Sin env-vars de Dropi, getToken() consulta la BD (app_settings) antes de rendirse.
const IS_MOCK = process.env.DROPI_MOCK === 'true';

async function makeCatalogClient() {
  const token = await getToken();
  return axios.create({
    baseURL: DROPI_API_BASE,
    timeout: 20000,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Origin':        'https://app.dropi.ec',
      'Referer':       'https://app.dropi.ec/dashboard/products',
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
}

function createWooClient() {
  return axios.create({
    baseURL: 'https://api.dropi.co/api/v1',
    timeout: 15000,
    headers: {
      'Authorization': `Bearer ${WOO_JWT}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
  });
}

const DROPI_CDN = 'https://d39ru7awumhhs2.cloudfront.net';

function toFullImageUrl(raw) {
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  return `${DROPI_CDN}/${raw.replace(/^\//, '')}`;
}

/**
 * Extracts variant groups from the raw Dropi product.
 * Dropi v4 stores variants in p.collections (array of color/size groups).
 * Normalized output: [{ option: 'Color', values: [{ label, image, stock }] }]
 */
function extractVariants(p) {
  // Dropi may store variants under different keys; pick the first that is a real array.
  const candidates = [p.collections, p.variants, p.product_variants, p.attributes];
  const collections = candidates.find(Array.isArray) ?? [];
  if (collections.length === 0) return [];

  return collections
    .map((col) => {
      if (!col || typeof col !== 'object') return null;
      const option = col.name ?? col.attribute ?? col.option ?? 'Variante';

      // Guard: items/options/values might be null, {}, a string, etc. — only use real arrays.
      const rawItems = [col.items, col.options, col.values].find(Array.isArray) ?? [];

      const values = rawItems
        .filter(Boolean) // skip null/undefined/0 entries inside the items list
        .map((item) => {
          if (item === null || item === undefined) return null;
          const label = typeof item === 'object'
            ? (item.name ?? item.value ?? item.label ?? String(item))
            : String(item);
          const image = typeof item === 'object'
            ? toFullImageUrl(item.urlS3 ?? item.url ?? item.image ?? item.photo ?? null)
            : null;
          const stock = typeof item === 'object' && item.stock != null
            ? parseInt(item.stock, 10)
            : null;
          return { label, image, stock };
        })
        .filter((v) => v?.label);

      return { option, values };
    })
    .filter((g) => g && g.values.length > 0);
}

// Normalizes Dropi v4 semantic-search product to a uniform shape.
// Response: { isSuccess, objects: { products: [], total, filters } }
function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null;

  // Dropi uses different gallery field names depending on the endpoint:
  //   catalog v4  → p.gallery  (array of { urlS3, url, main })
  //   product/:id → p.photos, p.product_photos, p.multimedia, p.pictures
  const gallery =
    p.gallery ??
    p.photos ??
    p.product_photos ??
    p.multimedia ??
    p.pictures ??
    p.images ??
    [];

  const mainPhoto = gallery.find?.((g) => g.main) ?? gallery[0] ?? null;
  const rawImg    = mainPhoto?.urlS3 ?? mainPhoto?.url ?? mainPhoto?.src ?? p.image ?? null;
  const imageUrl  = toFullImageUrl(rawImg);

  // Build full image array from gallery — used to persist in the DB images TEXT field
  const imagesArray = Array.isArray(gallery)
    ? gallery
        .map((g) => toFullImageUrl(g?.urlS3 ?? g?.url ?? g?.src ?? null))
        .filter(Boolean)
    : [];
  if (imageUrl && !imagesArray.includes(imageUrl)) imagesArray.unshift(imageUrl);

  const variants = extractVariants(p);

  // Technical detail blocks — these are the authoritative AI copy source.
  // Dropi product/:id uses different keys than the catalog endpoint.
  const rawDetails = [
    p.detail,
    p.details,
    p.product_detail,
    p.long_description,
    p.characteristics,
    p.caracteristicas,
    p.caracteristicas_tecnicas,
    p.specifications,
    p.especificaciones,
    p.features,
    p.features_list,
    p.ficha_tecnica,
    p.technical_sheet,
    p.guarantee,
    p.garantia,
    p.warranty,
  ]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join('\n\n');

  // Warehouse/bodega breakdown
  const warehouseRaw = [p.warehouses, p.bodegas, p.locations].find(Array.isArray) ?? [];
  const warehouses = warehouseRaw
    .filter(Boolean)
    .map((w) => {
      if (!w || typeof w !== 'object') return { name: String(w), stock: null };
      return {
        name:  w.name ?? w.nombre ?? w.bodega ?? w.warehouse ?? '',
        stock: w.stock ?? w.quantity ?? w.cantidad ?? null,
      };
    })
    .filter((w) => w.name);

  return {
    externalId:  String(p.id ?? p.sku ?? ''),
    title:       p.name ?? p.nombre ?? p.title ?? 'Sin nombre',
    description: p.description ?? p.descripcion ?? '',
    rawDetails,
    warehouses,
    image:       imageUrl,
    imagesArray,
    variants,
    price:       parseFloat(p.sale_price      ?? p.price        ?? p.precio_costo  ?? p.costo ?? 0),
    retailPrice: parseFloat(p.suggested_price ?? p.regular_price ?? p.precio_venta ?? p.pvp  ?? 0),
    stock:       parseInt(p.total_stock ?? p.stock_quantity ?? p.stock_simple ?? p.stock ?? -1, 10),
    sku:         p.sku ?? String(p.id ?? ''),
  };
}

function extractList(raw) {
  // Semantic search format: { isSuccess, objects: { products: [], total } }
  if (Array.isArray(raw?.objects?.products)) {
    const list  = raw.objects.products;
    const total = raw.objects.total ?? raw.count ?? list.length;
    return { list, total };
  }
  // Legacy Laravel format: { isSuccess, objects: [], count }
  if (Array.isArray(raw?.objects))  return { list: raw.objects,  total: raw.count ?? raw.objects.length };
  if (Array.isArray(raw))           return { list: raw,           total: raw.length };
  if (Array.isArray(raw?.data))     return { list: raw.data,      total: raw.total ?? raw.count ?? raw.data.length };
  if (Array.isArray(raw?.results))  return { list: raw.results,   total: raw.count ?? raw.total ?? raw.results.length };
  if (Array.isArray(raw?.products)) return { list: raw.products,  total: raw.total ?? raw.products.length };
  if (Array.isArray(raw?.items))    return { list: raw.items,     total: raw.total ?? raw.items.length };
  return { list: [], total: 0 };
}

function buildCatalogPayload(page, limit, keyword, categoryId, priceMin, priceMax, userVerified = false, userPremium = false) {
  // white_brand_id scopes results to the Ecuador dropshipping brand configured in Railway.
  // Without it, Dropi's semantic engine searches the global index and returns unrelated products.
  const whiteBrandId = Number(process.env.DROPI_WHITE_BRAND_ID) || null;

  const payload = {
    pageSize:         limit,
    startData:        (page - 1) * limit,
    privated_product: false,
    userVerified:     Boolean(userVerified),
    premium:          Boolean(userPremium),
    favorite:         false,
    country:          'ECUADOR',
    get_stock:        true,
    keywords:         keyword ?? '',
    no_count:         false,
    search_type:      'semantic',
    with_collection:  true,
  };

  if (whiteBrandId)            payload.white_brand_id = whiteBrandId;
  if (categoryId)              payload.categories_id  = [Number(categoryId)];
  if (priceMin != null)        payload.price_min      = Number(priceMin);
  if (priceMax != null)        payload.price_max      = Number(priceMax);
  return payload;
}

async function doFetch(page, limit, keyword, categoryId, priceMin, priceMax, userVerified = false, userPremium = false) {
  // Route through Cloudflare Worker when configured (bypasses Dropi WAF that blocks Railway IPs)
  if (process.env.DROPI_WORKER_URL && process.env.DROPI_WORKER_KEY) {
    return doFetchViaWorker(page, limit, keyword, categoryId, priceMin, priceMax, userVerified, userPremium);
  }

  // Direct call — only works from non-datacenter IPs (local dev)
  const client = await makeCatalogClient();
  const body   = buildCatalogPayload(page, limit, keyword, categoryId, priceMin, priceMax, userVerified, userPremium);

  const { data } = await client.post('/api/products/v4/index', body);

  if (!data || typeof data !== 'object') {
    throw new Error('Dropi devolvió una respuesta inesperada (no JSON).');
  }
  if (data.isSuccess === false) {
    const status = data.status ?? data.statusCode ?? 0;
    const err    = new Error(data.message ?? `Dropi error ${status}`);
    err.dropiStatus = status;
    throw err;
  }

  const { list, total } = extractList(data);
  const products = list.map(normalizeProduct).filter(Boolean);
  console.log(`[Dropi] catalog — page ${page}, ${products.length}/${total} productos`);
  return { products, total };
}

async function doFetchViaWorker(page, limit, keyword, categoryId, priceMin, priceMax, userVerified = false, userPremium = false) {
  const rawToken = await getToken();
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;
  const payload = buildCatalogPayload(page, limit, keyword, categoryId, priceMin, priceMax, userVerified, userPremium);

  const { data } = await axios.post(
    process.env.DROPI_WORKER_URL,
    {
      dropiToken: token,
      path:       '/api/products/v4/index',
      method:     'POST',
      payload,
    },
    {
      headers: { 'X-Worker-Key': process.env.DROPI_WORKER_KEY },
      timeout: 20000,
    }
  );

  if (!data || typeof data !== 'object') {
    throw new Error('Worker Dropi devolvió respuesta inesperada (no JSON).');
  }
  if (data.isSuccess === false) {
    const status = data.status ?? data.statusCode ?? 0;
    const err    = new Error(data.message ?? `Dropi error ${status}`);
    err.dropiStatus = status;
    throw err;
  }

  const { list, total } = extractList(data);
  const products = list.map(normalizeProduct).filter(Boolean);
  console.log(`[Dropi Worker] catalog — page ${page}, ${products.length}/${total} productos`);
  return { products, total };
}

/**
 * Fetches the Dropi product catalog.
 * Endpoint: POST https://api.dropi.ec/api/products/v4/index
 *
 * Auth strategy (in order):
 *   1. Cached in-memory token
 *   2. Auto-login via DROPI_USER_EMAIL + DROPI_USER_PASSWORD (if set in Railway)
 *   3. Static DROPI_SESSION_TOKEN (manual fallback)
 *
 * On 401/403: invalidates cache → retries once with a fresh token.
 */
async function fetchDropiCatalog({ page = 1, limit = 20, keyword = '', categoryId = null, priceMin = null, priceMax = null, userVerified = false, userPremium = false } = {}) {
  if (IS_MOCK) {
    console.warn('[Dropi] DROPI_MOCK=true — catálogo deshabilitado por flag explícita.');
    return { products: [], total: 0 };
  }

  // All paths return a value — no throw ever escapes this function.
  try {
    return await doFetch(page, limit, keyword, categoryId, priceMin, priceMax, userVerified, userPremium);
  } catch (err) {
    // Token ausente → respuesta vacía, no error.
    if (
      err.message?.includes('Sin token') ||
      err.message?.includes('No hay token') ||
      err.message?.includes('token de sesión')
    ) {
      console.warn('[Dropi] Sin token activo. Renueva vía POST /api/v1/import/dropi-token.');
      return { products: [], total: 0, dropiError: 'NO_TOKEN' };
    }

    const httpStatus  = err.response?.status;
    const dropiStatus = err.dropiStatus;
    const isAuthError = httpStatus === 401 || httpStatus === 403 ||
                        dropiStatus === 401 || dropiStatus === 403;

    if (isAuthError) {
      console.warn('[Dropi] Token rechazado (403/401) — invalidando caché y reintentando...');
      invalidateToken();
      try {
        return await doFetch(page, limit, keyword, categoryId, priceMin, priceMax, userVerified, userPremium);
      } catch (retryErr) {
        // Retry también falló — atrapar todo, nunca relanzar.
        const s2 = retryErr.response?.status ?? retryErr.dropiStatus;
        const code = (s2 === 401 || s2 === 403) ? 'AUTH_DENIED' : 'RETRY_FAILED';
        console.error(`[Dropi] Reintento fallido (${code}):`, retryErr.message);
        return { products: [], total: 0, dropiError: code, message: retryErr.message };
      }
    }

    // Cualquier otro error (timeout, red, 5xx Dropi) — nunca relanzar.
    console.error('[Dropi] fetchDropiCatalog error:', err.message);
    return { products: [], total: 0, dropiError: 'FETCH_FAILED', message: err.message };
  }
}

/**
 * Creates a fulfillment order in Dropi (uses WooCommerce integration token).
 *
 * payload shape:
 *   referenceId     — Aynimar order reference (e.g. "AYNIMAR-42")
 *   items           — [{ externalId, quantity, variant?, codAmount? }]
 *   shippingAddress — { name, phone, email, address, city, province, postalCode }
 *   codAmount       — optional Cash-on-Delivery total to collect from customer
 *   warehouse       — optional Dropi warehouse name/id for origin stock
 */
async function createOrderInDropi(payload) {
  if (!WOO_JWT) {
    const externalOrderId = `MOCK-DRP-${Date.now()}`;
    console.log(`[Dropi MOCK] createOrderInDropi — referenceId: ${payload.referenceId}, externalOrderId: ${externalOrderId}`);
    return { externalOrderId };
  }

  const client = createWooClient();

  const body = {
    referencia: payload.referenceId,
    productos:  payload.items.map((item) => {
      const p = { id_producto: item.externalId, cantidad: item.quantity };
      if (item.variant)   p.variante   = item.variant;
      if (item.codAmount) p.valor_cobrar = item.codAmount;
      return p;
    }),
    cliente: {
      nombre:        payload.shippingAddress.name,
      telefono:      payload.shippingAddress.phone,
      email:         payload.shippingAddress.email,
      direccion:     payload.shippingAddress.address,
      ciudad:        payload.shippingAddress.city,
      provincia:     payload.shippingAddress.province,
      codigo_postal: payload.shippingAddress.postalCode,
    },
  };

  // Optional top-level fields
  if (payload.codAmount) body.valor_a_cobrar = payload.codAmount;
  if (payload.warehouse) body.bodega         = payload.warehouse;

  const response = await client.post('/orders', body);

  const externalOrderId = response.data.id_orden ?? response.data.id ?? null;
  return { externalOrderId };
}

/**
 * Fetches the current delivery status of a Dropi order.
 * Returns the raw status string from Dropi (e.g. 'Generada', 'En transporte', 'Entregado').
 * Returns null when the order cannot be found or WOO_JWT is not configured.
 */
async function fetchDropiOrderStatus(dropiOrderId) {
  if (!WOO_JWT || !dropiOrderId) return null;

  try {
    const client = createWooClient();
    const { data } = await client.get(`/orders/${dropiOrderId}`);
    return (
      data.estado        ??
      data.status        ??
      data.estado_guia   ??
      data.delivery_status ??
      null
    );
  } catch (err) {
    console.warn(`[Dropi] fetchDropiOrderStatus(${dropiOrderId}) failed: ${err.message}`);
    return null;
  }
}

/**
 * Core fetch-by-ID logic (no retry). Used by fetchDropiProductById.
 * Strategy 1: GET /api/products/{id} (fast, may return 404 for some products)
 * Strategy 2: POST /api/products/v4/index keyword search, match by exact id/sku
 * Propagates 401/403 so the caller can attempt auto-refresh before retrying.
 */
async function _doFetchById(id) {
  const client = await makeCatalogClient();

  // Strategy 1: direct endpoint
  try {
    const { data } = await client.get(`/api/products/${id}`);
    const raw     = data?.objects ?? data;
    const product = Array.isArray(raw) ? raw[0] : raw;
    if (product && (product.id || product.name)) {
      // DEBUG — log raw keys so we can verify gallery/detail field names from Dropi
      console.log(`[Dropi DEBUG] raw keys for product ${id}:`, Object.keys(product).join(', '));
      console.log(`[Dropi DEBUG] gallery candidate fields — gallery:${JSON.stringify(product.gallery)?.slice(0,120)} | photos:${JSON.stringify(product.photos)?.slice(0,120)} | product_photos:${JSON.stringify(product.product_photos)?.slice(0,80)}`);
      console.log(`[Dropi DEBUG] detail candidate fields — detail:${String(product.detail ?? '').slice(0,120)} | details:${String(product.details ?? '').slice(0,120)} | long_description:${String(product.long_description ?? '').slice(0,120)} | characteristics:${String(product.characteristics ?? '').slice(0,120)}`);
      const normalized = normalizeProduct(product);
      if (normalized) return normalized;
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) throw err; // propagate auth errors — caller retries
    if (status !== 404) {
      console.warn(`[Dropi] GET /api/products/${id} failed (${status ?? err.message}) — falling back to keyword search`);
    }
  }

  // Strategy 2: keyword search fallback
  const body = buildCatalogPayload(1, 10, id, null, null, null);
  const { data } = await client.post('/api/products/v4/index', body); // throws on 401 — propagated
  const { list } = extractList(data);
  const match = list.find((p) => String(p.id) === id || String(p.sku) === id) ?? list[0];
  if (!match) throw new Error(`Producto ${id} no encontrado en Dropi.`);
  // DEBUG — same diagnostic for the keyword-search fallback path
  console.log(`[Dropi DEBUG] keyword-fallback raw keys for product ${id}:`, Object.keys(match).join(', '));
  console.log(`[Dropi DEBUG] gallery — gallery:${JSON.stringify(match.gallery)?.slice(0,120)} | photos:${JSON.stringify(match.photos)?.slice(0,120)}`);
  console.log(`[Dropi DEBUG] detail — detail:${String(match.detail ?? '').slice(0,120)} | long_description:${String(match.long_description ?? '').slice(0,120)}`);
  return normalizeProduct(match);
}

/**
 * Fetches a single Dropi product by its numeric ID with automatic token refresh.
 *
 * Flow:
 *   1. [Dropi Auth] Intentando conectar con token existente...
 *   2. On 401 → [Dropi Auth] Error 401 detectado. Renovando token en Dropi Ecuador...
 *   3. autoRefreshToken() → login with DROPI_EMAIL+PASSWORD → save to DB
 *   4. [Dropi Auth] Token renovado con éxito. Reintentando búsqueda de ID: {id}
 *   5. Returns product or throws DROPI_TOKEN_EXPIRED if refresh also fails.
 */
async function fetchDropiProductById(productId) {
  const id = String(productId).trim();

  if (process.env.DROPI_WORKER_URL && process.env.DROPI_WORKER_KEY) {
    return _fetchByIdViaWorker(id);
  }

  console.log(`[Dropi Auth] Intentando conectar con token existente para producto ${id}...`);

  try {
    return await _doFetchById(id);
  } catch (err) {
    const status = err.response?.status;
    if (status !== 401 && status !== 403) throw err; // non-auth error — propagate as-is

    console.log('[Dropi Auth] Error 401 detectado. Renovando token en Dropi Ecuador...');
    invalidateToken();

    try {
      await autoRefreshToken();
      console.log(`[Dropi Auth] Token renovado con éxito. Reintentando búsqueda de ID: ${id}`);
      return await _doFetchById(id);
    } catch (refreshErr) {
      console.warn('[Dropi Auth] Auto-renovación fallida:', refreshErr.message);
      const message = refreshErr.message.includes('credenciales') || refreshErr.message.includes('Sin credenciales')
        ? 'Token de Dropi expirado y no hay credenciales configuradas. ' +
          'Configura DROPI_EMAIL + DROPI_PASSWORD en Railway, o actualiza el token manualmente desde el importador.'
        : 'Token de Dropi expirado. Actualiza el token manualmente desde el importador.';
      const e = new Error(message);
      e.code = 'DROPI_TOKEN_EXPIRED';
      throw e;
    }
  }
}

// Throws a standardized DROPI_TOKEN_EXPIRED error when the Worker relays a
// Dropi 401/403. Without this, isSuccess=false responses are silently treated
// as "product not found", burying the real auth failure behind a 500.
function _assertWorkerAuthOk(data, context) {
  if (data?.isSuccess === false) {
    const status = data.status ?? data.statusCode ?? 0;
    if (status === 401 || status === 403) {
      const e = new Error(
        'Token de Dropi expirado o inválido. ' +
        'Actualiza el token manualmente desde el Importador de Dropi.',
      );
      e.code = 'DROPI_TOKEN_EXPIRED';
      throw e;
    }
  }
}

async function _fetchByIdViaWorker(id) {
  const rawToken = await getToken();
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

  // Try GET first via Worker
  try {
    const { data } = await axios.post(
      process.env.DROPI_WORKER_URL,
      { dropiToken: token, path: `/api/products/${id}`, method: 'GET', payload: {} },
      { headers: { 'X-Worker-Key': process.env.DROPI_WORKER_KEY }, timeout: 20000 },
    );
    _assertWorkerAuthOk(data, `GET /api/products/${id}`);
    const raw = data?.objects ?? data;
    const product = Array.isArray(raw) ? raw[0] : raw;
    if (product && (product.id || product.name)) {
      console.log(`[Dropi DEBUG Worker] raw keys for product ${id}:`, Object.keys(product).join(', '));
      const normalized = normalizeProduct(product);
      if (normalized) return normalized;
    }
  } catch (err) {
    // Re-throw auth errors immediately — no fallback for expired tokens.
    if (err.code === 'DROPI_TOKEN_EXPIRED') throw err;
    // Any other error (404, network): fall through to keyword-search.
  }

  // Worker keyword-search fallback
  const payload = buildCatalogPayload(1, 10, id, null, null, null);
  const { data } = await axios.post(
    process.env.DROPI_WORKER_URL,
    { dropiToken: token, path: '/api/products/v4/index', method: 'POST', payload },
    { headers: { 'X-Worker-Key': process.env.DROPI_WORKER_KEY }, timeout: 20000 },
  );
  _assertWorkerAuthOk(data, 'POST /api/products/v4/index');
  const { list } = extractList(data);
  const match = list.find((p) => String(p.id) === id || String(p.sku) === id) ?? list[0];
  if (!match) throw new Error(`Producto ${id} no encontrado en Dropi.`);
  console.log(`[Dropi DEBUG Worker] keyword-fallback raw keys for product ${id}:`, Object.keys(match).join(', '));
  return normalizeProduct(match);
}

/**
 * Searches Dropi by visual similarity.
 *
 * Dropi's WAF blocks JSON logins from Railway IPs, but the product-search endpoints
 * accept requests from any IP as long as the Bearer token is valid.
 * We therefore send the image DIRECTLY to Dropi as multipart/form-data (binary),
 * which is how their own browser client operates.
 *
 * The Worker path (large JSON base64 string) was rejected because:
 *   a) Some Cloudflare WAF rules flag large JSON payloads with base64 blobs.
 *   b) Dropi's image-search backend expects `Content-Type: multipart/form-data`,
 *      not `application/json`.
 *
 * @param {string} imageBase64  — pure base64, NO data-URL prefix
 */
async function searchDropiByImage({ imageBase64, page = 1, limit = 20 }) {
  const rawToken = await getToken();
  const token    = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;
  const whiteBrandId = Number(process.env.DROPI_WHITE_BRAND_ID) || null;

  // Detect image format from magic bytes (JPEG: 0xFF 0xD8 / PNG: 0x89 0x50)
  const buffer    = Buffer.from(imageBase64, 'base64');
  const isJpeg    = buffer[0] === 0xff && buffer[1] === 0xd8;
  const mediaType = isJpeg ? 'image/jpeg' : 'image/png';
  const filename  = isJpeg ? 'search.jpg'  : 'search.png';

  // Build multipart/form-data — mirrors the browser client exactly
  const form = new FormData();
  form.append('image',            buffer, { filename, contentType: mediaType });
  form.append('pageSize',         String(limit));
  form.append('startData',        String((page - 1) * limit));
  form.append('privated_product', 'false');
  form.append('userVerified',     'false');
  form.append('favorite',         'false');
  form.append('country',          'ECUADOR');
  form.append('get_stock',        'true');
  form.append('keywords',         '');
  form.append('no_count',         'false');
  form.append('search_type',      'image');
  form.append('with_collection',  'true');
  if (whiteBrandId) form.append('white_brand_id', String(whiteBrandId));

  try {
    const { data } = await axios.post(
      `${DROPI_API_BASE}/api/products/v4/index`,
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin:        'https://app.dropi.ec',
          Referer:       'https://app.dropi.ec/dashboard/products',
          'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...form.getHeaders(), // sets Content-Type: multipart/form-data; boundary=...
        },
        timeout:          35000,
        maxContentLength: 20 * 1024 * 1024,
      }
    );

    if (data?.isSuccess === false) {
      const err       = new Error(data.message ?? 'Dropi image-search falló (isSuccess=false)');
      err.dropiStatus = data.status ?? 0;
      throw err;
    }

    const { list, total } = extractList(data);
    console.log(`[Dropi Image Search] ${list.length}/${total} resultados para búsqueda visual.`);
    return { products: list.map(normalizeProduct).filter(Boolean), total, page };
  } catch (axiosErr) {
    // If the axios call failed with an HTTP response, enrich the error with Dropi's body.
    if (axiosErr.response?.data && !axiosErr.dropiStatus) {
      const dropiBody = axiosErr.response.data;
      const enriched  = new Error(dropiBody.message ?? dropiBody.error ?? axiosErr.message);
      enriched.dropiStatus = dropiBody.status ?? axiosErr.response.status;
      enriched.response    = axiosErr.response;
      console.error('[Dropi Image Search] Error HTTP:', enriched.dropiStatus, enriched.message);
      throw enriched;
    }
    console.error('[Dropi Image Search] Error:', axiosErr.message);
    throw axiosErr;
  }
}

module.exports = { fetchDropiCatalog, fetchDropiProductById, searchDropiByImage, createOrderInDropi, fetchDropiOrderStatus };
