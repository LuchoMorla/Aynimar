'use strict';

/**
 * Effi → Aynimar product transformer.
 *
 * Effi follows a Shopify-adjacent schema: English field names, `body_html`
 * for descriptions, and a nested `photos` array. Variants are also richer
 * than Dropi's flat structure.
 *
 * Reference Effi product shape (as of 2024 API):
 * {
 *   sku:                "EFF-78901",
 *   title:             "Silla Ergonómica Pro X200",
 *   body_html:         "<p>Descripción HTML...</p>",
 *   wholesale_price:   120.00,
 *   retail_price:      220.00,
 *   photos:            [{ url: "https://media.effi.com/img1.jpg", position: 1 }],
 *   inventory_quantity: 25,
 *   product_type:      "Mobiliario",
 *   vendor:            "ErgoHome",
 *   is_active:         true,
 *   variants: [{ option: "Color", values: ["Negro", "Blanco"] }]
 * }
 */

/**
 * Strips HTML tags and normalizes whitespace.
 * Same helper as Dropi transformer — kept local to avoid coupling.
 */
function stripHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Maps an Effi product_type to an Aynimar categoryId.
 *
 * @param {string} effiType
 * @param {Object} categoryMap  e.g. { 'Mobiliario': 4, 'Electrónica': 3 }
 * @param {number} defaultId
 * @returns {number}
 */
function resolveCategoryId(effiType, categoryMap = {}, defaultId = 1) {
  if (!effiType) return defaultId;
  return categoryMap[effiType] ?? defaultId;
}

/**
 * Extracts the ordered photo URLs from Effi's photos array.
 * Effi guarantees a `position` integer — we sort by it.
 */
function extractPhotos(effiPhotos) {
  if (!Array.isArray(effiPhotos) || effiPhotos.length === 0) return [];
  return [...effiPhotos]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((p) => p.url)
    .filter(Boolean);
}

/**
 * Transforms a single Effi product into the Aynimar internal format.
 *
 * @param {Object} effiProduct   Raw product object from Effi's API
 * @param {Object} options
 * @param {Object} options.categoryMap         { [effiProductType]: aynimarCategoryId }
 * @param {number} options.defaultCategoryId
 * @param {number} [options.businessId]
 * @returns {Object}  Ready to pass to ProductsService.create()
 */
function transformProduct(effiProduct, options = {}) {
  const {
    categoryMap = {},
    defaultCategoryId = 1,
    businessId = null,
  } = options;

  const images = extractPhotos(effiProduct.photos);
  const primaryImage = images[0] || null;

  if (!primaryImage) {
    throw new Error(
      `Effi product ${effiProduct.sku} has no photos — skipped.`
    );
  }

  const price = parseFloat(effiProduct.retail_price ?? effiProduct.wholesale_price ?? 0);
  if (price <= 0) {
    throw new Error(
      `Effi product ${effiProduct.sku} has an invalid price (${price}) — skipped.`
    );
  }

  const description = stripHtml(effiProduct.body_html);
  if (description.length < 10) {
    throw new Error(
      `Effi product ${effiProduct.sku} has a description that is too short — skipped.`
    );
  }

  const name = String(effiProduct.title ?? '').slice(0, 50).trim();
  if (name.length < 3) {
    throw new Error(`Effi product ${effiProduct.sku} has a title that is too short — skipped.`);
  }

  return {
    // ── Core product fields ──────────────────────────────────────────
    name,
    price,
    description,
    image:          primaryImage,
    stock:          Number.isInteger(effiProduct.inventory_quantity)
                      ? effiProduct.inventory_quantity
                      : null,
    categoryId:     resolveCategoryId(effiProduct.product_type, categoryMap, defaultCategoryId),
    businessId,
    isDeleted:      false,
    showShop:       effiProduct.is_active !== false,

    // ── Sync / multi-image fields ────────────────────────────────────
    externalId:     String(effiProduct.sku),
    sourceProvider: 'effi',
    lastSyncAt:     new Date(),
    images:         JSON.stringify(images),
  };
}

/**
 * Transforms an array of Effi products.
 * Skips invalid products and collects errors without halting the batch.
 *
 * @returns {{ products: Object[], errors: { externalId: string, reason: string }[] }}
 */
function transformProducts(effiProducts, options = {}) {
  const products = [];
  const errors = [];

  for (const raw of effiProducts) {
    try {
      products.push(transformProduct(raw, options));
    } catch (err) {
      errors.push({ externalId: raw?.sku ?? 'unknown', reason: err.message });
    }
  }

  return { products, errors };
}

module.exports = { transformProduct, transformProducts, resolveCategoryId };
