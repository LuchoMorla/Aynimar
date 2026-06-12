'use strict';

const axios = require('axios');

const DROPI_BASE_URL = process.env.DROPI_BASE_URL || 'https://api.dropi.co/api/v1';

// WOO_CONSUMER_SECRET holds the Dropi JWT token used to authenticate
// with Dropi's API (Bearer auth). WOO_CONSUMER_KEY is the numeric store ID.
const DROPI_JWT      = process.env.WOO_CONSUMER_SECRET || process.env.DROPI_API_KEY || '';
const DROPI_STORE_ID = process.env.WOO_CONSUMER_KEY    || '';
const IS_MOCK        = !DROPI_JWT || process.env.DROPI_MOCK === 'true';

function createHttpClient() {
  return axios.create({
    baseURL: DROPI_BASE_URL,
    timeout: 15000,
    headers: {
      'Authorization': `Bearer ${DROPI_JWT}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
  });
}

/**
 * Fetches the Dropi product catalog for the connected merchant.
 * Uses WOO_CONSUMER_SECRET (Dropi JWT) as Bearer token.
 *
 * @param {{ page?: number, limit?: number, keyword?: string }} options
 * @returns {{ products: Array, total: number }}
 */
async function fetchDropiCatalog({ page = 1, limit = 20, keyword = '' } = {}) {
  if (IS_MOCK) {
    console.warn('[Dropi] WOO_CONSUMER_SECRET not set — returning empty catalog. Set the env var to connect to Dropi.');
    return { products: [], total: 0 };
  }

  const client = createHttpClient();

  const params = { page, per_page: limit };
  if (keyword) params.search = keyword;

  // Dropi exposes merchant catalog under /products (paginated)
  const response = await client.get('/products', { params });

  const raw = response.data;

  // Normalize: Dropi can return { results, count } or a flat array
  const list  = Array.isArray(raw) ? raw : (raw.results ?? raw.products ?? []);
  const total = Array.isArray(raw) ? list.length : (raw.count ?? raw.total ?? list.length);

  const products = list.map((p) => ({
    externalId:   String(p.id ?? p.sku ?? ''),
    title:        p.name ?? p.title ?? p.nombre ?? 'Sin nombre',
    description:  p.description ?? p.descripcion ?? '',
    image:        p.image ?? p.images?.[0]?.src ?? p.foto ?? null,
    price:        parseFloat(p.price ?? p.precio_costo ?? p.wholesale_price ?? 0),
    retailPrice:  parseFloat(p.regular_price ?? p.precio_venta ?? p.retail_price ?? 0),
    stock:        parseInt(p.stock_quantity ?? p.stock ?? p.cantidad ?? -1, 10),
    sku:          p.sku ?? String(p.id ?? ''),
  }));

  return { products, total };
}

/**
 * Creates a fulfillment order in Dropi when a customer buys a Dropi product.
 */
async function createOrderInDropi(payload) {
  if (IS_MOCK) {
    const externalOrderId = `MOCK-DRP-${Date.now()}`;
    console.log(
      `[Dropi MOCK] createOrderInDropi — referenceId: ${payload.referenceId}, ` +
      `items: ${payload.items.map((i) => `${i.externalId}×${i.quantity}`).join(', ')}, ` +
      `externalOrderId: ${externalOrderId}`
    );
    return { externalOrderId };
  }

  const client = createHttpClient();

  const response = await client.post('/orders', {
    referencia: payload.referenceId,
    productos:  payload.items.map((item) => ({
      id_producto: item.externalId,
      cantidad:    item.quantity,
    })),
    cliente: {
      nombre:        payload.shippingAddress.name,
      telefono:      payload.shippingAddress.phone,
      email:         payload.shippingAddress.email,
      direccion:     payload.shippingAddress.address,
      ciudad:        payload.shippingAddress.city,
      provincia:     payload.shippingAddress.province,
      codigo_postal: payload.shippingAddress.postalCode,
    },
  });

  const externalOrderId = response.data.id_orden ?? response.data.id ?? null;
  return { externalOrderId };
}

module.exports = { fetchDropiCatalog, createOrderInDropi };
