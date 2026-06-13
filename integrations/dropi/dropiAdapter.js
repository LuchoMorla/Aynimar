'use strict';

const axios = require('axios');
const { getToken, invalidateToken } = require('./dropiAuthService');

const WOO_JWT        = process.env.WOO_CONSUMER_SECRET || '';
const DROPI_API_BASE = process.env.DROPI_API_URL       || 'https://api.dropi.ec';

const hasCredentials =
  !!(process.env.DROPI_SESSION_TOKEN ||
     (process.env.DROPI_USER_EMAIL && process.env.DROPI_USER_PASSWORD));

const IS_MOCK = !hasCredentials || process.env.DROPI_MOCK === 'true';

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
  const collections = p.collections ?? p.variants ?? p.product_variants ?? p.attributes ?? [];
  if (!Array.isArray(collections) || collections.length === 0) return [];

  return collections
    .map((col) => {
      const option = col.name ?? col.attribute ?? col.option ?? 'Variante';
      const rawItems = col.items ?? col.options ?? col.values ?? [];
      const values = rawItems
        .map((item) => ({
          label: item.name ?? item.value ?? item.label ?? String(item),
          image: toFullImageUrl(item.urlS3 ?? item.url ?? item.image ?? item.photo ?? null),
          stock: item.stock != null ? parseInt(item.stock, 10) : null,
        }))
        .filter((v) => v.label);
      return { option, values };
    })
    .filter((g) => g.values.length > 0);
}

// Normalizes Dropi v4 semantic-search product to a uniform shape.
// Response: { isSuccess, objects: { products: [], total, filters } }
function normalizeProduct(p) {
  const gallery   = p.gallery ?? p.photos ?? p.images ?? [];
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
  // Dropi may store them in several field names depending on product type.
  const rawDetails = [
    p.detail          ?? p.details          ?? '',
    p.characteristics ?? p.caracteristicas  ?? '',
    p.specifications  ?? p.especificaciones ?? '',
    p.guarantee       ?? p.garantia         ?? p.warranty ?? '',
  ].map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).join('\n\n');

  // Warehouse/bodega breakdown — gives merchants visibility on origin stock.
  const warehouseRaw = p.warehouses ?? p.bodegas ?? p.locations ?? [];
  const warehouses = Array.isArray(warehouseRaw)
    ? warehouseRaw
        .map((w) => ({
          name:  w.name ?? w.nombre ?? w.bodega ?? w.warehouse ?? String(w),
          stock: w.stock ?? w.quantity ?? w.cantidad ?? null,
        }))
        .filter((w) => w.name)
    : [];

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

function buildCatalogPayload(page, limit, keyword, categoryId, priceMin, priceMax) {
  const payload = {
    pageSize:         limit,
    startData:        (page - 1) * limit,
    privated_product: false,
    userVerified:     false,
    favorite:         false,
    country:          'ECUADOR',
    get_stock:        true,
    keywords:         keyword ?? '',
    no_count:         false,
    search_type:      'semantic',
    with_collection:  true,
  };
  if (categoryId)              payload.categories_id = [Number(categoryId)];
  if (priceMin != null)        payload.price_min     = Number(priceMin);
  if (priceMax != null)        payload.price_max     = Number(priceMax);
  return payload;
}

async function doFetch(page, limit, keyword, categoryId, priceMin, priceMax) {
  // Route through Cloudflare Worker when configured (bypasses Dropi WAF that blocks Railway IPs)
  if (process.env.DROPI_WORKER_URL && process.env.DROPI_WORKER_KEY) {
    return doFetchViaWorker(page, limit, keyword, categoryId, priceMin, priceMax);
  }

  // Direct call — only works from non-datacenter IPs (local dev)
  const client = await makeCatalogClient();
  const body   = buildCatalogPayload(page, limit, keyword, categoryId, priceMin, priceMax);

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
  const products = list.map(normalizeProduct);
  console.log(`[Dropi] catalog — page ${page}, ${products.length}/${total} productos`);
  return { products, total };
}

async function doFetchViaWorker(page, limit, keyword, categoryId, priceMin, priceMax) {
  const rawToken = await getToken();
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;
  const payload = buildCatalogPayload(page, limit, keyword, categoryId, priceMin, priceMax);

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
  const products = list.map(normalizeProduct);
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
async function fetchDropiCatalog({ page = 1, limit = 20, keyword = '', categoryId = null, priceMin = null, priceMax = null } = {}) {
  if (IS_MOCK) {
    console.warn('[Dropi] Sin credenciales — catálogo deshabilitado. Configura DROPI_USER_EMAIL+PASSWORD o DROPI_SESSION_TOKEN en Railway.');
    return { products: [], total: 0 };
  }

  try {
    return await doFetch(page, limit, keyword, categoryId, priceMin, priceMax);
  } catch (err) {
    const httpStatus  = err.response?.status;
    const dropiStatus = err.dropiStatus;
    const isAuthError = httpStatus === 401 || httpStatus === 403 ||
                        dropiStatus === 401 || dropiStatus === 403;

    if (isAuthError) {
      console.warn('[Dropi] Token rechazado (403/401) — invalidando caché y reintentando...');
      invalidateToken();
      try {
        return await doFetch(page, limit, keyword, categoryId, priceMin, priceMax);
      } catch (retryErr) {
        const s2 = retryErr.response?.status ?? retryErr.dropiStatus;
        if (s2 === 401 || s2 === 403) {
          throw new Error('Dropi denegó el acceso. Renueva DROPI_SESSION_TOKEN o verifica DROPI_USER_EMAIL+PASSWORD en Railway.');
        }
        throw retryErr;
      }
    }

    throw err;
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

async function searchDropiByImage({ imageBase64, page = 1, limit = 20 }) {
  if (!process.env.DROPI_WORKER_URL || !process.env.DROPI_WORKER_KEY) {
    throw new Error('DROPI_WORKER_URL/KEY no configurados.');
  }
  const rawToken = await getToken();
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

  const payload = {
    pageSize:         limit,
    startData:        (page - 1) * limit,
    privated_product: false,
    userVerified:     false,
    favorite:         false,
    country:          'ECUADOR',
    get_stock:        true,
    keywords:         '',
    no_count:         false,
    search_type:      'image',
    with_collection:  true,
    image_base64:     imageBase64,
  };

  const { data } = await axios.post(
    process.env.DROPI_WORKER_URL,
    { dropiToken: token, path: '/api/products/v4/index', method: 'POST', payload },
    { headers: { 'X-Worker-Key': process.env.DROPI_WORKER_KEY }, timeout: 30000 }
  );

  if (data?.isSuccess === false) {
    const err = new Error(data.message ?? 'Dropi image-search error');
    err.dropiStatus = data.status ?? 0;
    throw err;
  }

  const { list, total } = extractList(data);
  return { products: list.map(normalizeProduct), total, page };
}

module.exports = { fetchDropiCatalog, searchDropiByImage, createOrderInDropi, fetchDropiOrderStatus };
