'use strict';

/**
 * WooCommerce Emulator — "Modo Espejo Dropi"
 *
 * Dropi's official connector integrates exclusively with WooCommerce stores.
 * This router makes our Express backend look like a WooCommerce REST API v3
 * store from Dropi's perspective.
 *
 * Mount: app.use('/wp-json/wc/v3', woocommerceMirror)  ← set in routes/index.js
 *
 * Auth: WooCommerce Basic Auth
 *   Header: Authorization: Basic base64(WOO_CONSUMER_KEY:WOO_CONSUMER_SECRET)
 *   Both values must be set as Railway environment variables — never hardcoded.
 *
 * Endpoints:
 *   GET  /          Handshake — Dropi verifies this is a valid WC store
 *   POST /products  Dropi pushes catalog products → we store them in our DB
 *   GET  /products  Dropi reads our catalog (optional, for inventory sync)
 *   GET  /orders    Dropi polls for orders it should fulfill
 *   POST /orders    Dropi sends fulfillment status updates back to us
 */

const express = require('express');
const { models } = require('../libs/sequelize');

const router = express.Router();

const STORE_URL = process.env.NEXT_PUBLIC_FRONTEND_URL ?? 'https://www.aynimar.com';

// ── Basic Auth guard ──────────────────────────────────────────────────────────
// Dropi sends:  Authorization: Basic base64(consumerKey:consumerSecret)
// We validate against WOO_CONSUMER_KEY and WOO_CONSUMER_SECRET env vars.

function wooBasicAuth(req, res, next) {
  const authHeader = req.headers['authorization'] ?? '';

  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Aynimar WC Emulator"');
    return res.status(401).json({
      code:    'woocommerce_rest_authentication_error',
      message: 'Authorization header missing or malformed.',
      data:    { status: 401 },
    });
  }

  let key, secret;
  try {
    const decoded  = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    key    = decoded.slice(0, colonIdx);
    secret = decoded.slice(colonIdx + 1); // secret may contain ':' (e.g. a JWT)
  } catch {
    return res.status(401).json({
      code:    'woocommerce_rest_authentication_error',
      message: 'Malformed Basic Auth credentials.',
      data:    { status: 401 },
    });
  }

  const expectedKey    = process.env.WOO_CONSUMER_KEY    ?? '';
  const expectedSecret = process.env.WOO_CONSUMER_SECRET ?? '';

  if (!expectedKey || !expectedSecret) {
    console.error('[WC Mirror] WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET not set in environment.');
    return res.status(503).json({ message: 'WC emulator not configured on this server.' });
  }

  if (key !== expectedKey || secret !== expectedSecret) {
    return res.status(401).json({
      code:    'woocommerce_rest_authentication_error',
      message: 'Invalid consumer key or secret.',
      data:    { status: 401 },
    });
  }

  next();
}

router.use(wooBasicAuth);

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapProductToWC(product) {
  let images = [];
  try {
    const parsed = JSON.parse(product.images ?? '[]');
    if (Array.isArray(parsed)) {
      images = parsed.map((url, i) => ({ id: i + 1, src: url, alt: product.name, position: i }));
    }
  } catch {}
  if (images.length === 0 && product.image) {
    images = [{ id: 1, src: product.image, alt: product.name, position: 0 }];
  }

  const stockQty = product.stock ?? 0;

  return {
    id:                 product.id,
    name:               product.name,
    slug:               String(product.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    permalink:          `${STORE_URL}/store/${product.id}`,
    date_created:       product.createdAt,
    date_modified:      product.updatedAt,
    type:               'simple',
    status:             product.showShop !== false ? 'publish' : 'draft',
    catalog_visibility: 'visible',
    description:        product.description ?? '',
    short_description:  '',
    sku:                product.externalId ?? String(product.id),
    price:              String(product.price ?? 0),
    regular_price:      String(product.price ?? 0),
    sale_price:         '',
    manage_stock:       true,
    stock_quantity:     stockQty,
    stock_status:       stockQty > 0 ? 'instock' : 'outofstock',
    backorders:         'no',
    backorders_allowed: false,
    backordered:        false,
    weight:             '',
    categories: [{ id: product.categoryId ?? 1, name: 'General', slug: 'general' }],
    images,
    meta_data: [
      { key: '_aynimar_id',      value: String(product.id) },
      { key: '_source_provider', value: product.sourceProvider ?? 'dropi' },
    ],
  };
}

// WooCommerce status ↔ Aynimar stateOrder
const WC_TO_AYNIMAR = {
  pending:    'comprado_pendiente_pago',
  processing: 'comprado_pendiente_negocio',
  'on-hold':  'aprobado',
  completed:  'entregado',
  cancelled:  'cancelado',
  refunded:   'cancelado',
  failed:     'error_api_proveedor',
};

// ── GET / ─────────────────────────────────────────────────────────────────────
// WooCommerce handshake. Dropi calls this to verify the store connection.

router.get('/', (req, res) => {
  res.json({
    name:            'Aynimar',
    description:     'Economía Circular Ecuador',
    url:             STORE_URL,
    home_url:        STORE_URL,
    gmt_offset:      '-5',
    timezone_string: 'America/Guayaquil',
    namespace:       'wc/v3',
    woocommerce:     '7.0.0',
    authentication: {
      oauth1: {
        request_token: `${STORE_URL}/oauth1/request`,
        authorize:     `${STORE_URL}/oauth1/authorize`,
        access_token:  `${STORE_URL}/oauth1/access`,
      },
    },
    routes: {
      '/products': {
        namespace: 'wc/v3',
        methods:   ['GET', 'POST'],
        endpoints: [
          { methods: ['GET'],  args: { page: {}, per_page: {}, sku: {} } },
          { methods: ['POST'], args: {} },
        ],
      },
      '/orders': {
        namespace: 'wc/v3',
        methods:   ['GET', 'POST'],
        endpoints: [
          { methods: ['GET'],  args: { page: {}, per_page: {}, status: {} } },
          { methods: ['POST'], args: {} },
        ],
      },
    },
  });
});

// ── POST /products ────────────────────────────────────────────────────────────
// Dropi pushes its catalog products here when the admin selects them in
// Dropi's panel. We receive WooCommerce-format JSON and upsert into our DB.

router.post('/products', async (req, res, next) => {
  try {
    const wc = req.body ?? {};

    const externalId = String(wc.sku ?? '').trim();
    if (!externalId) {
      return res.status(400).json({
        code:    'missing_sku',
        message: 'Product must include a non-empty sku field.',
        data:    { status: 400 },
      });
    }

    const images = Array.isArray(wc.images)
      ? wc.images.map((img) => img.src).filter(Boolean)
      : [];

    const price    = parseFloat(wc.regular_price ?? wc.price ?? 0);
    const stockQty = Number.isInteger(wc.stock_quantity) ? wc.stock_quantity : 0;

    const productData = {
      name:           String(wc.name ?? '').slice(0, 50).trim(),
      price,
      description:    wc.description || wc.short_description || '',
      image:          images[0] ?? null,
      images:         JSON.stringify(images),
      stock:          stockQty,
      categoryId:     wc.categories?.[0]?.id ?? 1,
      showShop:       wc.status === 'publish',
      isDeleted:      false,
      externalId,
      sourceProvider: 'dropi',
      lastSyncAt:     new Date(),
    };

    const [product, created] = await models.Product.findOrCreate({
      where:    { externalId, sourceProvider: 'dropi' },
      defaults: productData,
    });

    if (!created) {
      await product.update({
        price,
        stock:     stockQty,
        image:     productData.image,
        images:    productData.images,
        showShop:  productData.showShop,
        lastSyncAt: new Date(),
      });
    }

    res.status(created ? 201 : 200).json(mapProductToWC(created ? product : { ...product.toJSON(), ...productData }));
  } catch (err) {
    next(err);
  }
});

// ── GET /products ─────────────────────────────────────────────────────────────
// Dropi may read this to reconcile its catalog with our current inventory.

router.get('/products', async (req, res, next) => {
  try {
    const page     = Math.max(1, Number(req.query.page)      || 1);
    const per_page = Math.min(100, Number(req.query.per_page) || 20);
    const sku      = req.query.sku ? String(req.query.sku).trim() : null;

    const where = { isDeleted: false };
    if (sku) where.externalId = sku;

    const products = await models.Product.findAll({
      where,
      limit:  per_page,
      offset: (page - 1) * per_page,
      order:  [['id', 'DESC']],
    });

    res.json(products.map(mapProductToWC));
  } catch (err) {
    next(err);
  }
});

// ── GET /orders ───────────────────────────────────────────────────────────────
// Dropi polls this to find orders it needs to dispatch (status=processing).

router.get('/orders', async (req, res, next) => {
  try {
    const page     = Math.max(1, Number(req.query.page) || 1);
    const per_page = Math.min(100, Number(req.query.per_page) || 20);
    const wcStatus = req.query.status ?? 'processing';

    const aynimarState = WC_TO_AYNIMAR[wcStatus] ?? wcStatus;

    const orders = await models.Order.findAll({
      where: { stateOrder: aynimarState },
      include: [{
        model:   models.OrderItem,
        as:      'items',
        include: [{ model: models.Product, as: 'product' }],
      }],
      limit:  per_page,
      offset: (page - 1) * per_page,
      order:  [['id', 'DESC']],
    });

    const wcOrders = orders.map((o) => ({
      id:            o.id,
      status:        wcStatus,
      currency:      'USD',
      date_created:  o.createdAt,
      date_modified: o.updatedAt,
      total:         String(o.total ?? 0),
      line_items: (o.items ?? []).map((item) => ({
        id:       item.id,
        name:     item.product?.name       ?? 'Unknown',
        sku:      item.product?.externalId ?? String(item.productId),
        quantity: item.amount  ?? 1,
        price:    String(item.unitPrice ?? item.product?.price ?? 0),
        total:    String((item.amount ?? 1) * (item.unitPrice ?? item.product?.price ?? 0)),
        meta_data: [{ key: '_aynimar_item_id', value: String(item.id) }],
      })),
      meta_data: [{ key: '_aynimar_order_id', value: String(o.id) }],
    }));

    res.json(wcOrders);
  } catch (err) {
    next(err);
  }
});

// ── POST /orders ──────────────────────────────────────────────────────────────
// Dropi calls this to report status updates:
//   on-hold   → Dropi picked up the order and is preparing it
//   completed → Order delivered to the customer
//   cancelled → Dropi cancelled the order
//
// When Dropi includes shipping/tracking data, we extract it and transition
// the order to 'en_transito', storing trackingNumber and carrierName.

router.post('/orders', async (req, res, next) => {
  try {
    const wcOrder  = req.body ?? {};
    const wcStatus = wcOrder.status ?? '';
    const metaData = Array.isArray(wcOrder.meta_data) ? wcOrder.meta_data : [];

    // Find our internal orderId from meta_data
    const aynimarMeta = metaData.find((m) => m.key === '_aynimar_order_id');
    const orderId     = aynimarMeta ? Number(aynimarMeta.value) : null;

    if (!orderId || isNaN(orderId)) {
      return res.status(200).json({ id: wcOrder.id ?? 0, status: wcStatus, received: true });
    }

    // ── Extract tracking info from multiple possible Dropi payload locations ──
    // Dropi may send tracking in top-level fields, meta_data, or shipping_lines.
    const metaGet = (keys) =>
      metaData.find((m) => keys.includes(m.key))?.value ?? null;

    const trackingNumber =
      wcOrder.tracking_number                                         ||
      wcOrder.tracking?.number                                        ||
      metaGet(['tracking_number', '_tracking_number', 'guia', 'numero_guia', 'guide_number']) ||
      wcOrder.shipping_lines?.[0]?.tracking_number                   ||
      null;

    const carrierName =
      wcOrder.carrier_name                                            ||
      wcOrder.tracking?.carrier                                       ||
      metaGet(['carrier_name', '_carrier_name', 'transportadora', 'carrier', 'shipping_company']) ||
      null;

    // ── Build the update payload ──────────────────────────────────────────────
    // If tracking info is present, override the state to 'en_transito'
    // regardless of the wcStatus WooCommerce sent.
    const hasTracking = Boolean(trackingNumber);

    const updatePayload = {};

    if (hasTracking) {
      updatePayload.stateOrder     = 'en_transito';
      updatePayload.trackingNumber = String(trackingNumber).trim();
      if (carrierName) updatePayload.carrierName = String(carrierName).trim();
    } else {
      const mapped = WC_TO_AYNIMAR[wcStatus];
      if (mapped) updatePayload.stateOrder = mapped;
    }

    if (Object.keys(updatePayload).length > 0) {
      await models.Order.update(updatePayload, { where: { id: orderId } });
    }

    res.status(200).json({
      id:             orderId,
      status:         wcStatus,
      stateOrder:     updatePayload.stateOrder   ?? null,
      trackingNumber: updatePayload.trackingNumber ?? null,
      carrierName:    updatePayload.carrierName    ?? null,
      updated:        Object.keys(updatePayload).length > 0,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
