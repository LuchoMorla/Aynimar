'use strict';

/**
 * ImportService — Effi product import pipeline.
 *
 * Dropi products are no longer imported via native API. They are received
 * automatically through the WooCommerce emulator at POST /wp-json/wc/v3/products.
 *
 * This service retains only:
 *   - Effi catalog import (importFromEffi, importSingleProduct for Effi)
 *   - Stock sync (syncProductStock, syncAllStock) for Effi
 *   - upsertProduct helper (shared with woocommerceMirror via direct model access)
 */

const { models } = require('../libs/sequelize');

const { fetchProductsFromEffi, fetchStockFromEffi, fetchProductByIdFromEffi } = require('./effi/effiAdapter');
const { transformProduct: transformEffiOne, transformProducts: transformEffi } = require('./effi/effiTransformer');

// ── Internal helpers ──────────────────────────────────────────────────────────

async function upsertProduct(normalizedProduct) {
  const { externalId, sourceProvider, price, stock, image, images, lastSyncAt, ...createFields } = normalizedProduct;

  const [product, created] = await models.Product.findOrCreate({
    where: { externalId, sourceProvider },
    defaults: normalizedProduct,
  });

  if (!created) {
    await product.update({ price, stock, image, images, lastSyncAt });
  }

  return { action: created ? 'created' : 'updated', product };
}

async function runBatch(normalizedProducts) {
  const result = { created: 0, updated: 0, errors: [] };

  for (const p of normalizedProducts) {
    try {
      const { action } = await upsertProduct(p);
      if (action === 'created') result.created++;
      else result.updated++;
    } catch (err) {
      result.errors.push({ externalId: p.externalId, reason: err.message });
    }
  }

  return result;
}

// ── Effi import ───────────────────────────────────────────────────────────────

async function importFromEffi(options = {}) {
  const { page = 1, limit = 50, productType, categoryMap = {}, defaultCategoryId = 1, businessId } = options;

  const { products: rawProducts, total } = await fetchProductsFromEffi({ page, limit, productType });

  const transformOptions = { categoryMap, defaultCategoryId, businessId };
  const { products: normalized, errors: transformErrors } = transformEffi(rawProducts, transformOptions);

  const batchResult = await runBatch(normalized);

  return {
    provider: 'effi',
    fetched:  rawProducts.length,
    total,
    ...batchResult,
    errors: [...transformErrors, ...batchResult.errors],
  };
}

/**
 * Imports a single product by externalId from Effi.
 * Dropi products are received via the WooCommerce emulator — not via this function.
 */
async function importSingleProduct({
  provider,
  externalId,
  pvpOverride,
  defaultCategoryId = 1,
  categoryMap = {},
  businessId = null,
}) {
  if (provider === 'dropi') {
    throw new Error(
      'Dropi product import via native API is disabled. ' +
      'Products sync automatically through the WooCommerce connector at POST /wp-json/wc/v3/products.'
    );
  }

  if (provider !== 'effi') {
    throw new Error(`Unknown provider "${provider}". Only "effi" is supported for manual import.`);
  }

  const raw        = await fetchProductByIdFromEffi(externalId);
  const normalized = transformEffiOne(raw, { categoryMap, defaultCategoryId, businessId });

  if (pvpOverride !== undefined && pvpOverride !== null) {
    const pvp = parseFloat(pvpOverride);
    if (!isNaN(pvp) && pvp > 0) normalized.price = pvp;
  }

  const { action, product } = await upsertProduct(normalized);
  return { action, externalId: normalized.externalId, provider, productId: product.id, name: normalized.name };
}

// ── Stock sync ────────────────────────────────────────────────────────────────

async function syncProductStock(externalId, sourceProvider) {
  if (sourceProvider !== 'effi') {
    throw new Error(
      `Stock sync for "${sourceProvider}" via native API is not supported. ` +
      'Dropi stock updates are received through the WooCommerce webhook.'
    );
  }

  const { stock: newStock } = await fetchStockFromEffi(externalId);

  const [updatedCount] = await models.Product.update(
    { stock: newStock, lastSyncAt: new Date() },
    { where: { externalId, sourceProvider } }
  );

  return { externalId, stock: newStock, updated: updatedCount > 0 };
}

async function syncAllStock(sourceProvider) {
  if (sourceProvider !== 'effi') {
    throw new Error(
      `Bulk stock sync for "${sourceProvider}" via native API is not supported.`
    );
  }

  const products = await models.Product.findAll({
    where: { sourceProvider, isDeleted: false },
    attributes: ['id', 'externalId', 'sourceProvider'],
  });

  let synced = 0;
  const errors = [];

  for (const product of products) {
    try {
      await syncProductStock(product.externalId, sourceProvider);
      synced++;
    } catch (err) {
      errors.push({ externalId: product.externalId, reason: err.message });
    }
  }

  return { synced, errors };
}

module.exports = { importFromEffi, importSingleProduct, syncProductStock, syncAllStock };
