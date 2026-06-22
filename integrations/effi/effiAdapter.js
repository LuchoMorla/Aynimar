'use strict';

/**
 * Effi API Adapter
 *
 * Responsability: talk to Effi's HTTP API (or return mock data in dev/test).
 * This is the single point of contact with Effi's network interface.
 *
 * Effi uses Bearer token auth and a Shopify-compatible REST structure.
 * Toggle mock mode with EFFI_MOCK=true or by omitting EFFI_API_KEY.
 */

const EFFI_BASE_URL = process.env.EFFI_BASE_URL || 'https://api.effi.co/api/v1';

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
const EFFI_API_KEY  = process.env.EFFI_API_KEY  || 'MOCK_KEY';
const IS_MOCK       = !process.env.EFFI_API_KEY || process.env.EFFI_MOCK === 'true';

// ── Mock dataset ─────────────────────────────────────────────────────────────

const MOCK_PRODUCTS = [
  {
    sku:                'EFF-78901',
    title:              'Silla Ergonómica Pro X200',
    body_html:          '<p>Silla de oficina con respaldo de malla transpirable, altura ajustable con pistón clase 4, reposabrazos 4D y soporte lumbar extraíble. Capacidad máxima 120 kg.</p>',
    wholesale_price:    110.00,
    retail_price:       218.99,
    photos: [
      { url: 'https://images.unsplash.com/photo-1592078615290-033ee584e267?w=600', position: 1 },
      { url: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=600', position: 2 },
    ],
    inventory_quantity: 30,
    product_type:       'Mobiliario',
    vendor:             'ErgoHome',
    is_active:          true,
    variants: [{ option: 'Color', values: ['Negro', 'Blanco', 'Gris'] }],
  },
  {
    sku:                'EFF-78902',
    title:              'Escritorio Standing Desk Eléctrico',
    body_html:          '<p>Escritorio de altura regulable eléctricamente de 70 a 120 cm. Motor silencioso, tablero de 120x60 cm en roble o blanco, y memorias de 4 posiciones.</p>',
    wholesale_price:    195.00,
    retail_price:       389.00,
    photos: [
      { url: 'https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=600', position: 1 },
    ],
    inventory_quantity: 12,
    product_type:       'Mobiliario',
    vendor:             'FlexiDesk',
    is_active:          true,
    variants: [{ option: 'Color tablero', values: ['Roble', 'Blanco'] }],
  },
  {
    sku:                'EFF-45301',
    title:              'Lámpara LED de Escritorio Táctil',
    body_html:          '<p>Lámpara de escritorio con 3 modos de color (cálido, neutro, frío), 5 niveles de brillo, control táctil y puerto USB-A de carga. Cuello flexible de 360°.</p>',
    wholesale_price:    12.00,
    retail_price:       28.50,
    photos: [
      { url: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=600', position: 1 },
      { url: 'https://images.unsplash.com/photo-1540932239986-30128078f3c5?w=600', position: 2 },
    ],
    inventory_quantity: 85,
    product_type:       'Hogar y Decoración',
    vendor:             'LuxLight',
    is_active:          true,
    variants: [],
  },
  {
    sku:                'EFF-11201',
    title:              'Set de Yoga 6 Piezas Eco Premium',
    body_html:          '<p>Kit completo de yoga: tapete antideslizante de caucho natural 6mm, 2 bloques de espuma, correa de extensión, bolsa de transporte y toalla absorbente. Materiales certificados.</p>',
    wholesale_price:    22.00,
    retail_price:       55.99,
    photos: [
      { url: 'https://images.unsplash.com/photo-1545205597-3d9d02c29597?w=600', position: 1 },
    ],
    inventory_quantity: 40,
    product_type:       'Deportes y Fitness',
    vendor:             'ZenGear',
    is_active:          true,
    variants: [{ option: 'Color tapete', values: ['Azul', 'Morado', 'Verde'] }],
  },
  {
    sku:                'EFF-78905',
    title:              'Monitor Curvo 27" 165Hz FHD',
    body_html:          '<p>Monitor gaming curvo 1500R de 27 pulgadas, resolución Full HD 1080p, tasa de refresco 165Hz, tiempo de respuesta 1ms MPRT, panel VA, compatible con AMD FreeSync Premium.</p>',
    wholesale_price:    150.00,
    retail_price:       299.99,
    photos: [
      { url: 'https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=600', position: 1 },
      { url: 'https://images.unsplash.com/photo-1593640408182-31c228af22e3?w=600', position: 2 },
    ],
    inventory_quantity: 18,
    product_type:       'Tecnología',
    vendor:             'AOC',
    is_active:          true,
    variants: [],
  },
];

// ── HTTP client factory ───────────────────────────────────────────────────────

function createHttpClient() {
  const headers = {
    'Authorization': `Bearer ${EFFI_API_KEY}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
  return {
    get: (path, { params } = {}) => {
      const url = new URL(EFFI_BASE_URL + path);
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      return fetchJson(url.toString(), { method: 'GET', headers, timeout: 15000 });
    },
    post: (path, body) => fetchJson(EFFI_BASE_URL + path, { method: 'POST', headers, body: JSON.stringify(body), timeout: 15000 }),
  };
}

// ── Public adapter functions ──────────────────────────────────────────────────

/**
 * Fetches a page of products from Effi.
 *
 * @param {Object} params
 * @param {number} [params.page=1]
 * @param {number} [params.limit=50]
 * @param {string} [params.productType]  Filter by Effi product_type (optional)
 * @returns {Promise<{ products: Object[], total: number, page: number }>}
 */
async function fetchProductsFromEffi({ page = 1, limit = 50, productType = null } = {}) {
  if (IS_MOCK) {
    console.log('[Effi] Running in MOCK mode — returning simulated catalog.');
    const filtered = productType
      ? MOCK_PRODUCTS.filter((p) => p.product_type === productType)
      : MOCK_PRODUCTS;
    return {
      products: filtered,
      total:    filtered.length,
      page:     1,
    };
  }

  const client = createHttpClient();
  const queryParams = { page, per_page: limit };
  if (productType) queryParams.product_type = productType;

  // Effi follows Shopify's REST pagination: /products.json?page=N&per_page=N
  const data = await client.get('/products.json', { params: queryParams });

  return {
    products: data.products ?? [],
    total:    data.count ?? 0,
    page,
  };
}

/**
 * Fetches the current stock for a single product from Effi.
 *
 * @param {string} externalId   The Effi SKU (e.g. "EFF-78901")
 * @returns {Promise<{ externalId: string, stock: number }>}
 */
async function fetchStockFromEffi(externalId) {
  if (IS_MOCK) {
    const mock = MOCK_PRODUCTS.find((p) => p.sku === externalId);
    const stock = mock?.inventory_quantity ?? 0;
    console.log(`[Effi MOCK] Stock for ${externalId}: ${stock}`);
    return { externalId, stock };
  }

  const client = createHttpClient();
  const data = await client.get(`/products/${externalId}/inventory.json`);
  return {
    externalId,
    stock: data.inventory_quantity ?? 0,
  };
}

/**
 * Creates a fulfillment order in Effi (Shopify-compatible REST API).
 *
 * Same failure contract as Dropi: throws on error so OrderService can catch it
 * and mark the order as 'error_api_proveedor' without reverting payment.
 *
 * @param {Object} payload
 * @param {string}   payload.referenceId
 * @param {Array<{externalId: string, quantity: number}>} payload.items
 * @param {Object}   payload.shippingAddress
 * @returns {Promise<{ externalOrderId: string }>}
 */
async function createOrderInEffi(payload) {
  if (IS_MOCK) {
    const externalOrderId = `MOCK-EFF-${Date.now()}`;
    console.log(
      `[Effi MOCK] createOrderInEffi — referenceId: ${payload.referenceId}, ` +
      `items: ${payload.items.map((i) => `${i.externalId}×${i.quantity}`).join(', ')}, ` +
      `externalOrderId: ${externalOrderId}`
    );
    return { externalOrderId };
  }

  const client = createHttpClient();

  // Effi follows the Shopify naming convention: split full name into first/last.
  const [firstName = '', ...rest] = (payload.shippingAddress.name ?? '').split(' ');
  const lastName = rest.join(' ');

  const data = await client.post('/orders.json', {
    order: {
      line_items: payload.items.map((item) => ({
        sku:      item.externalId,
        quantity: item.quantity,
      })),
      shipping_address: {
        first_name: firstName,
        last_name:  lastName,
        address1:   payload.shippingAddress.address,
        city:       payload.shippingAddress.city,
        province:   payload.shippingAddress.province,
        zip:        payload.shippingAddress.postalCode,
        phone:      payload.shippingAddress.phone,
        country:    payload.shippingAddress.countryOfResidence,
      },
      email: payload.shippingAddress.email,
      note:  `Aynimar order: ${payload.referenceId}`,
    },
  });

  const externalOrderId = data?.order?.id ?? null;
  return { externalOrderId };
}

/**
 * Fetches a single product from Effi by its SKU (externalId).
 * Used by importSingleProduct to import one specific item from the admin UI.
 *
 * @param {string} externalId  The Effi SKU (e.g. "EFF-78901")
 * @returns {Promise<Object>}  Raw Effi product object
 */
async function fetchProductByIdFromEffi(externalId) {
  if (IS_MOCK) {
    const product = MOCK_PRODUCTS.find((p) => p.sku === String(externalId));
    if (!product) throw new Error(`Product "${externalId}" not found in Effi catalog.`);
    return product;
  }

  const client = createHttpClient();
  const data = await client.get(`/products/${externalId}.json`);
  return data.product;
}

module.exports = { fetchProductsFromEffi, fetchStockFromEffi, fetchProductByIdFromEffi, createOrderInEffi };
