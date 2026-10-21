'use strict';

const { getToken, invalidateToken, autoRefreshToken } = require('./dropiAuthService');

async function fetchJson(url, { method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      const err = new Error(`HTTP ${res.status}`);
      err.response = { status: res.status, data: errData };
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

const DROPI_API_BASE    = process.env.DROPI_API_URL     || 'https://api.dropi.ec';

// IS_MOCK sólo se activa con la flag explícita DROPI_MOCK=true.
// Sin env-vars de Dropi, getToken() consulta la BD (app_settings) antes de rendirse.
const IS_MOCK = process.env.DROPI_MOCK === 'true';

async function makeCatalogClient() {
  const token = await getToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'Origin':        'https://app.dropi.ec',
    'Referer':       'https://app.dropi.ec/dashboard/products',
    'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  return {
    post: (path, body) => fetchJson(`${DROPI_API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), timeout: 20000 }),
    get:  (path)       => fetchJson(`${DROPI_API_BASE}${path}`, { headers, timeout: 20000 }),
  };
}

const DROPI_CDN = 'https://d39ru7awumhhs2.cloudfront.net';

function toFullImageUrl(raw) {
  if (!raw) return null;
  const url = raw.startsWith('http') ? raw : `${DROPI_CDN}/${raw.replace(/^\//, '')}`;
  try {
    new URL(url);
    return url;
  } catch {
    try {
      const encoded = encodeURI(url);
      new URL(encoded);
      console.log('[Dropi] encoded invalid URI:', url, '→', encoded);
      return encoded;
    } catch {
      console.log('[Dropi] unparseable image URL, skipping:', url);
      return null;
    }
  }
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
          // Preserve the Dropi variant item ID — required for 1:1 dispatch via selectedDropiId.
          // Dropi may use different keys; try all known candidates.
          const dropiVariantId = typeof item === 'object'
            ? (item.id ?? item.item_id ?? item.variant_id ?? item.product_id ?? null)
            : null;
          const entry = { label, image, stock };
          if (dropiVariantId != null) entry.id = String(dropiVariantId);
          return entry;
        })
        .filter((v) => v?.label);

      return { option, values };
    })
    .filter((g) => g && g.values.length > 0);
}

// Normalizes Dropi v4 semantic-search product to a uniform shape.
// Response: { isSuccess, objects: { products: [], total, filters } }
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null;

  // Dropi uses different gallery field names depending on the endpoint:
  //   catalog v4  → p.gallery  (array of { urlS3, url, main })
  //   product/:id → p.photos, p.product_photos, p.multimedia, p.pictures
  // Use .find() so empty arrays are skipped (Dropi sometimes returns gallery:[] with real photos in another field).
  const gallery = [p.gallery, p.photos, p.product_photos, p.multimedia, p.pictures, p.images]
    .find((a) => Array.isArray(a) && a.length > 0) ?? [];

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

  // Use || (not ??) for string fields: Dropi sometimes returns '' for empty fields,
  // which ?? treats as a valid value. || falls through empty strings to the next candidate.
  return {
    externalId:  String(p.id ?? p.sku ?? ''),
    title:       p.name || p.nombre || p.nombre_producto || p.titulo || p.title || p.product_name || 'Sin nombre',
    description: p.description || p.descripcion || p.descripcion_corta || p.short_description || '',
    rawDetails,
    warehouses,
    image:       imageUrl,
    imagesArray,
    variants,
    price:       parseFloat(p.sale_price || p.price || p.precio || p.precio_costo || p.costo || p.cost_price || 0),
    retailPrice: parseFloat(p.suggested_price || p.regular_price || p.precio_venta || p.pvp || p.precio_sugerido || 0),
    stock:       intOrNull(p.total_stock ?? p.stock_quantity ?? p.stock_simple ?? p.stock ?? null), // sin dato → null (antes -1)
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

  const data = await client.post('/api/products/v4/index', body);

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

  const data = await fetchJson(process.env.DROPI_WORKER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Key': process.env.DROPI_WORKER_KEY },
    body:    JSON.stringify({ dropiToken: token, path: '/api/products/v4/index', method: 'POST', payload }),
    timeout: 30000,
  });

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

// ── Transporte de órdenes: interfaz { create(body), get(id) } ───────────────
// mock (POR DEFECTO): no sale nada a la red; devuelve ids MOCK-DRP-*.
// http: vía OFICIAL de Ecuador, copiada del plugin wc-dropi-integration 4.7.3
//   (clasess/models/OrdersModel.php + Constants.php 'EC'):
//   POST https://api.dropi.ec/integrations/orders/myorders
//   cabecera dropi-integration-key: <DROPI_INTEGRATION_KEY>
//   respuesta { isSuccess, message, objects: { id } }
//   Solo DROPI_ORDER_TRANSPORT=http + DROPI_ORDER_HTTP_ENABLED=true + DROPI_INTEGRATION_KEY. No hay endpoints de
//   Colombia ni el antiguo /api/v1/orders. Ver docs/ORDER_AUTOMATION.md.
// DROPI_MOCK=true fuerza mock. En producción, preDispatch NUNCA deja que un pedido
// real se "envíe" por mock (se bloquea con excepción): evita el bug de da29068.
const DROPI_ORDER_PATH = '/integrations/orders/myorders';
const DROPI_ORDER_STATUS_PENDING = 'PENDIENTE CONFIRMACION';

function orderTransportName() {
  return process.env.DROPI_MOCK !== 'true' && process.env.DROPI_ORDER_TRANSPORT === 'http' ? 'http' : 'mock';
}

/**
 * Configuración del transporte http. Nunca devuelve el token en los mensajes.
 * @returns {{ ok: true, url: string, token: string } | { ok: false, error: string }}
 */
function orderHttpConfig(env = process.env) {
  if (env.DROPI_ORDER_API_URL) {
    return { ok: false, error: 'DROPI_ORDER_API_URL (antiguo /api/v1/orders) ya no se usa: bórrala y usa DROPI_ORDER_API_HOST (por defecto api.dropi.ec).' };
  }
  const raw = String(env.DROPI_ORDER_API_HOST || 'api.dropi.ec').trim();
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, error: `DROPI_ORDER_API_HOST inválido (${raw})` }; }
  const host = u.hostname.toLowerCase();
  if (/\.co$/.test(host) || /\/api\/v1\/orders/.test(u.pathname)) {
    return { ok: false, error: `DROPI_ORDER_API_HOST rechazado (${host}${u.pathname}): no hay endpoints de Colombia ni /api/v1/orders; solo api.dropi.ec.` };
  }
  const official = u.protocol === 'https:' && host === 'api.dropi.ec' && !u.port;
  // Servidor HTTP falso de los tests: solo 127.0.0.1 y solo con NODE_ENV=test.
  const fakeLocal = env.NODE_ENV === 'test' && u.protocol === 'http:' && host === '127.0.0.1';
  if (!official && !fakeLocal) return { ok: false, error: `DROPI_ORDER_API_HOST rechazado (${host}): solo https://api.dropi.ec.` };
  if (u.pathname !== '/' || u.search) return { ok: false, error: 'DROPI_ORDER_API_HOST debe ser solo el host, sin ruta.' };
  // CEO-004: además del token, un flag explícito (el piloto es manual hasta que se encienda).
  if (env.DROPI_ORDER_HTTP_ENABLED !== 'true') return { ok: false, error: 'Transporte http de órdenes Dropi DESHABILITADO: falta DROPI_ORDER_HTTP_ENABLED=true (autorización del propietario).' };
  const token = String(env.DROPI_INTEGRATION_KEY || '').trim();
  if (!token) return { ok: false, error: 'Transporte http de órdenes Dropi DESHABILITADO: falta DROPI_INTEGRATION_KEY (token de Dropi > Mis integraciones).' };
  return { ok: true, url: `${u.origin}${DROPI_ORDER_PATH}`, token };
}

/** null si el transporte activo puede enviar; si no, el motivo (sin secretos). Lo usa preDispatch y el arranque. */
function orderTransportError(env = process.env) {
  if (orderTransportName() !== 'http') return null;
  const c = orderHttpConfig(env);
  return c.ok ? null : c.error;
}

// Dedupe local por shop_order_id (además del claim atómico en BD de _dispatchOrder):
// una petición en vuelo se comparte; tras un id, se devuelve el mismo id; tras un
// resultado desconocido NO se vuelve a enviar (Dropi no documenta consulta por
// shop_order_id). Solo releaseShopOrder (resolución not_created) lo libera.
// ponytail: memoria del proceso; con varias réplicas manda el claim de BD.
const sentShopOrders = new Map(); // shop_order_id → Promise | { id } | { unknown: msg }
function releaseShopOrder(shopOrderId) { sentShopOrders.delete(String(shopOrderId)); }

async function postOrderHttp(body) {
  const c = orderHttpConfig();
  if (!c.ok) throw new Error(c.error); // definitivo: no se llamó a Dropi
  const timeout = Math.max(100, Number(process.env.DROPI_ORDER_TIMEOUT_MS) || 20000);
  let data;
  try {
    data = await fetchJson(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Accept': 'application/json', 'dropi-integration-key': c.token },
      body: JSON.stringify(body),
      timeout,
    });
  } catch (cause) {
    // Error nuevo: el AbortError de fetch es un DOMException con message de solo lectura.
    const st = cause.response?.status;
    const ambiguous = !st || st >= 500 || st === 408;
    const detail = typeof cause.response?.data?.message === 'string' ? `: ${cause.response.data.message.slice(0, 300)}` : '';
    const what = st ? `HTTP ${st}` : (cause.name === 'AbortError' ? 'timeout' : (cause.name || 'error de red'));
    throw Object.assign(new Error(`Dropi create_order ${what}${detail}${ambiguous ? ' (resultado desconocido)' : ''}`), { ambiguous, response: cause.response });
  }
  if (data?.isSuccess === false) {
    // Dropi rechazó la orden (no la creó): definitivo y sin reintento automático.
    const err = new Error(`Dropi rechazó la orden: ${String(data.message || data.status || 'sin mensaje').slice(0, 300)}`);
    err.ambiguous = false;
    err.permanent = true;
    throw err;
  }
  const externalOrderId = data?.objects?.id;
  if (externalOrderId === undefined || externalOrderId === null || externalOrderId === '') {
    const err = new Error('Dropi respondió sin objects.id (resultado desconocido)');
    err.ambiguous = true;
    throw err;
  }
  return { externalOrderId: String(externalOrderId) };
}

const ORDER_TRANSPORTS = {
  mock: {
    async create(body) {
      const externalOrderId = `MOCK-DRP-${Date.now()}${Math.floor(Math.random() * 1000)}`;
      console.log(`[Dropi MOCK] create_order — shop_order_id: ${body.shop_order_id}, externalOrderId: ${externalOrderId}`);
      return { externalOrderId };
    },
    async get() { return null; }, // los tests inyectan estados
  },
  http: {
    async create(body) {
      const key = String(body.shop_order_id);
      const prev = sentShopOrders.get(key);
      if (prev instanceof Promise) return prev;
      if (prev?.id) return { externalOrderId: prev.id, deduped: true };
      if (prev?.unknown) {
        throw Object.assign(new Error(`${key} ya se envió con resultado desconocido (${prev.unknown}); no se reintenta: revisión humana`), { ambiguous: true });
      }
      const p = postOrderHttp(body).then(
        (r) => { sentShopOrders.set(key, { id: r.externalOrderId }); return r; },
        (err) => {
          if (err.ambiguous) sentShopOrders.set(key, { unknown: err.message.slice(0, 200) });
          else sentShopOrders.delete(key); // Dropi no la creó: el reintento acotado es seguro
          throw err;
        },
      );
      sentShopOrders.set(key, p);
      return p;
    },
    // La API de integraciones no documenta consulta de estado (ni por id ni por
    // shop_order_id): los estados se revisan en el panel o con el MCP del operador.
    async get() { return null; },
  },
};

/**
 * Cuerpo EXACTO del plugin oficial (OrdersModel::save), sin el token del producto
 * (va solo en la cabecera) y con create_product_if_not_exist=false (nunca crea productos).
 * state/city llegan ya en el formato configurado (orderAutomationService.buildShipping).
 */
function buildCreateOrderBody(payload) {
  const c = payload.customer || {};
  const products = (payload.products || []).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.variation_id ? 'VARIABLE' : 'SIMPLE',
    user_id: payload.supplierId,
    quantity: p.quantity,
    price: p.price,
    ...(p.variation_id ? { variation_id: p.variation_id } : {}),
  }));
  const total = Math.round(products.reduce((s, p) => s + p.price * p.quantity, 0) * 100) / 100;
  return {
    total_order: total,
    notes: payload.shopOrderId,
    name: c.name,
    surname: c.surname,
    dir: c.dir,
    country: 'EC',
    state: c.state,
    city: c.city,
    phone: c.phone,
    client_email: c.email || '',
    payment_method_id: 1,
    status: DROPI_ORDER_STATUS_PENDING,
    type: 'FINAL_ORDER',
    rate_type: payload.rateType,
    products,
    calculate_costs_and_shiping: true,
    supplier_id: payload.supplierId,
    shop_order_id: payload.shopOrderId,
    create_product_if_not_exist: false,
  };
}

/**
 * Crea la orden de venta en Dropi. Solo la llama OrderService._dispatchOrder
 * tras pasar orderAutomationService.preDispatch (validación, interruptor,
 * supervisión). Ver docs/ORDER_AUTOMATION.md.
 *
 * payload: { shopOrderId, rateType, codAmount, supplierId, customer:{name,surname,dir,state,city,phone,email?},
 *            products:[{id, name, price, quantity, variation_id?}] }
 * shop_order_id = clave de idempotencia (AYNIMAR-<id>).
 *
 * Errores: err.ambiguous = true cuando NO se puede saber si Dropi creó la orden
 * (timeout, red, 5xx, 2xx sin objects.id) → el llamador NO reintenta (DISPATCH_UNKNOWN).
 * err.permanent = true con isSuccess=false: Dropi la rechazó → excepción sin reintento.
 */
async function createOrderInDropi(payload) {
  return ORDER_TRANSPORTS[orderTransportName()].create(buildCreateOrderBody(payload));
}

/** Estado actual de una orden en Dropi → { status, trackingNumber, carrierName, shippingCost } | null. */
async function fetchDropiOrderStatus(dropiOrderId) {
  if (!dropiOrderId) return null;
  try {
    return await ORDER_TRANSPORTS[orderTransportName()].get(dropiOrderId);
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
    const data = await client.get(`/api/products/${id}`);
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
  const data = await client.post('/api/products/v4/index', body); // throws on 401 — propagated
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
    try {
      return await _fetchByIdViaWorker(id);
    } catch (err) {
      if (err.code !== 'DROPI_TOKEN_EXPIRED') throw err;
      console.log('[Dropi Auth] Token expirado (Worker path). Renovando...');
      invalidateToken();
      try {
        await autoRefreshToken();
        console.log(`[Dropi Auth] Token renovado. Reintentando Worker para ID: ${id}`);
        return await _fetchByIdViaWorker(id);
      } catch (refreshErr) {
        // 2FA pending — propagate so the route handler can return 202
        if (refreshErr.code === 'DROPI_2FA_PENDING') throw refreshErr;
        console.warn('[Dropi Auth] Auto-renovación fallida (Worker path):', refreshErr.message);
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
      // 2FA pending — propagate so the route handler can return 202
      if (refreshErr.code === 'DROPI_2FA_PENDING') throw refreshErr;
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
    const data = await fetchJson(process.env.DROPI_WORKER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Key': process.env.DROPI_WORKER_KEY },
      body:    JSON.stringify({ dropiToken: token, path: `/api/products/${id}`, method: 'GET', payload: {} }),
      timeout: 30000,
    });
    _assertWorkerAuthOk(data, `GET /api/products/${id}`);
    const raw = data?.objects ?? data;
    const product = Array.isArray(raw) ? raw[0] : raw;
    if (product && (product.id || product.name)) {
      console.log(`[Dropi DEBUG Worker] raw keys for product ${id}:`, Object.keys(product).join(', '));
      const normalized = normalizeProduct(product);
      if (normalized) return normalized;
    }
  } catch (err) {
    if (err.code === 'DROPI_TOKEN_EXPIRED') throw err;
    // HTTP 401/403 from the Worker means the Dropi token is expired/invalid — surface it properly.
    if (err.response?.status === 401 || err.response?.status === 403) {
      const e = new Error('Token de Dropi expirado o inválido. Actualiza el token desde el Importador de Dropi.');
      e.code = 'DROPI_TOKEN_EXPIRED';
      throw e;
    }
    // Any other error (404, network): fall through to keyword-search.
  }

  // Worker keyword-search fallback
  const payload = buildCatalogPayload(1, 10, id, null, null, null);
  let searchData;
  try {
    searchData = await fetchJson(process.env.DROPI_WORKER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Key': process.env.DROPI_WORKER_KEY },
      body:    JSON.stringify({ dropiToken: token, path: '/api/products/v4/index', method: 'POST', payload }),
      timeout: 30000,
    });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      const e = new Error('Token de Dropi expirado o inválido. Actualiza el token desde el Importador de Dropi.');
      e.code = 'DROPI_TOKEN_EXPIRED';
      throw e;
    }
    throw err;
  }
  _assertWorkerAuthOk(searchData, 'POST /api/products/v4/index');
  const { list } = extractList(searchData);
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
  // Native FormData (Node 20 global) — no npm package needed
  const form = new FormData();
  form.append('image',            new Blob([buffer], { type: mediaType }), filename);
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

  const imgController = new AbortController();
  const imgTimer = setTimeout(() => imgController.abort(), 35000);
  try {
    // Native fetch sets Content-Type: multipart/form-data; boundary=... automatically when body is FormData
    const res = await fetch(`${DROPI_API_BASE}/api/products/v4/index`, {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin:        'https://app.dropi.ec',
        Referer:       'https://app.dropi.ec/dashboard/products',
        'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body:   form,
      signal: imgController.signal,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      const err = new Error(errData?.message ?? errData?.error ?? `HTTP ${res.status}`);
      err.dropiStatus = errData?.status ?? res.status;
      err.response    = { status: res.status, data: errData };
      console.error('[Dropi Image Search] Error HTTP:', err.dropiStatus, err.message);
      throw err;
    }

    const data = await res.json();

    if (data?.isSuccess === false) {
      const err       = new Error(data.message ?? 'Dropi image-search falló (isSuccess=false)');
      err.dropiStatus = data.status ?? 0;
      throw err;
    }

    const { list, total } = extractList(data);
    console.log(`[Dropi Image Search] ${list.length}/${total} resultados para búsqueda visual.`);
    return { products: list.map(normalizeProduct).filter(Boolean), total, page };
  } catch (err) {
    console.error('[Dropi Image Search] Error:', err.message);
    throw err;
  } finally {
    clearTimeout(imgTimer);
  }
}

module.exports = { normalizeProduct, fetchDropiCatalog, fetchDropiProductById, searchDropiByImage, createOrderInDropi, fetchDropiOrderStatus, orderTransportName, orderHttpConfig, orderTransportError, releaseShopOrder, buildCreateOrderBody, ORDER_TRANSPORTS };
