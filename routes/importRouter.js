'use strict';

const express  = require('express');
const passport = require('passport');
const Joi      = require('joi');

const { Op }               = require('sequelize');
const { checkRoles }       = require('../middlewares/authHandler');
const validatorHandler     = require('../middlewares/validatorHandler');
const { importFromEffi, importSingleProduct, syncProductStock, syncAllStock } = require('../integrations/importService');
const { fetchProductsFromEffi } = require('../integrations/effi/effiAdapter');
const { fetchDropiCatalog, searchDropiByImage } = require('../integrations/dropi/dropiAdapter');
const { generateProductCopy } = require('../integrations/aiCopyService');
const { models }           = require('../libs/sequelize');

const router = express.Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const effiQuerySchema = Joi.object({
  page:              Joi.number().integer().min(1).default(1),
  limit:             Joi.number().integer().min(1).max(200).default(50),
  defaultCategoryId: Joi.number().integer().min(1).default(1),
  businessId:        Joi.number().integer().allow(null),
});

const importProductSchema = Joi.object({
  provider:          Joi.string().valid('effi', 'dropi').required(),
  externalId:        Joi.string().required(),
  pvpOverride:       Joi.number().positive().allow(null).default(null),
  defaultCategoryId: Joi.number().integer().min(1).default(1),
  businessId:        Joi.number().integer().allow(null).default(null),
  categoryMap:       Joi.object().default({}),
  // Dropi live-catalog upsert fields (sent when product not yet in local DB)
  title:             Joi.string().allow('', null).default(null),
  name:              Joi.string().allow('', null).default(null),
  image:             Joi.string().allow('', null).default(null),
  description:       Joi.string().allow('', null).default(''),
  price:             Joi.number().min(0).allow(null).default(0),
  retailPrice:       Joi.number().min(0).allow(null).default(null),
  stock:             Joi.number().integer().allow(null).default(null),
  imagesJson:        Joi.string().allow('', null).default(null),
  variantsJson:      Joi.string().allow('', null).default(null),
  // Raw technical details from Dropi — used as primary AI copy context
  rawDetails:        Joi.string().allow('', null).default(''),
});

const syncStockSchema = Joi.object({
  externalId:     Joi.string().required(),
  sourceProvider: Joi.string().valid('effi').required(),
});

const syncAllSchema = Joi.object({
  provider: Joi.string().valid('effi').required(),
});

// ── GET /catalog is accessible by admin AND business-owner ───────────────────

router.get(
  '/catalog',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const provider = String(req.query.provider ?? 'dropi');
      const page     = Number(req.query.page)    || 1;
      const limit    = Number(req.query.limit)   || 20;
      const keyword  = req.query.keyword ? String(req.query.keyword).trim() : '';

      if (provider === 'dropi') {
        const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
        const priceMin   = req.query.priceMin   !== undefined ? Number(req.query.priceMin)   : null;
        const priceMax   = req.query.priceMax   !== undefined ? Number(req.query.priceMax)   : null;

        const { products: dropiProducts, total } = await fetchDropiCatalog({ page, limit, keyword, categoryId, priceMin, priceMax });

        // Annotate which products are already imported (have a businessId in our DB)
        const externalIds = dropiProducts.map((p) => p.externalId).filter(Boolean);
        const existing    = externalIds.length
          ? await models.Product.findAll({
              where:      { externalId: externalIds, sourceProvider: 'dropi' },
              attributes: ['externalId', 'businessId'],
            })
          : [];
        const importedSet = new Set(
          existing.filter((r) => r.businessId != null).map((r) => r.externalId)
        );

        const products = dropiProducts.map((p) => ({
          ...p,
          alreadyImported: importedSet.has(p.externalId),
        }));

        return res.json({ products, total, page });
      }

      if (provider === 'effi') {
        const { products, total } = await fetchProductsFromEffi({ page, limit });

        const externalIds = products.map((p) => p.sku);
        const existing    = await models.Product.findAll({
          where: { externalId: externalIds, sourceProvider: 'effi' },
          attributes: ['externalId'],
        });
        const existingSet = new Set(existing.map((p) => p.externalId));

        let annotated = products.map((p) => ({
          ...p,
          externalId:      p.sku,
          alreadyImported: existingSet.has(p.sku),
        }));

        if (keyword) {
          const kw = keyword.toLowerCase();
          annotated = annotated.filter((p) =>
            (p.title ?? '').toLowerCase().includes(kw) ||
            (p.externalId ?? '').toLowerCase().includes(kw)
          );
        }

        return res.json({ products: annotated, total: keyword ? annotated.length : total, page });
      }

      return res.status(400).json({ message: `Provider "${provider}" no soportado. Usa "dropi" o "effi".` });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/import/dropi-token ──────────────────────────────────────────
// Persists a fresh Dropi session token in PostgreSQL — no redeploy needed.
// Accessible by admin and business_owner (Dropi blocks server-side login via Cloudflare).

router.post(
  '/dropi-token',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
        return res.status(400).json({ message: 'Body debe contener { token: "<JWT válido>" }' });
      }
      const { saveTokenToDB }   = require('../integrations/dropi/dropiTokenService');
      const { invalidateToken } = require('../integrations/dropi/dropiAuthService');
      await saveTokenToDB(token);
      invalidateToken();
      console.log('[Dropi] Token actualizado vía endpoint admin.');
      res.json({ message: 'Token de Dropi guardado en BD. El catálogo usará este token en la próxima petición.' });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/import/image-search ─────────────────────────────────────────
// Receives { imageBase64, page, limit } — proxies to Dropi image-similarity search.

router.post(
  '/image-search',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { imageBase64, page = 1, limit = 20 } = req.body;
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.status(400).json({ message: 'imageBase64 (string) requerido en el body.' });
      }
      const result = await searchDropiByImage({ imageBase64, page: Number(page), limit: Number(limit) });
      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/import/product (dropi) ──────────────────────────────────────
// Upserts a Dropi product into the local DB and assigns it to a business.
// If the product already exists (synced via WooCommerce), just updates it.
// If it only exists in the live Dropi catalog, creates it from the supplied data.

router.post(
  '/product',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(importProductSchema, 'body'),
  async (req, res, next) => {
    try {
      const {
        provider, externalId, pvpOverride, businessId, defaultCategoryId,
        title, name: nameField, image, description, price, stock,
      } = req.body;

      if (provider === 'dropi') {
        const resolvedName  = title ?? nameField ?? externalId;
        const resolvedPrice = pvpOverride ?? price ?? 0;
        const catId         = defaultCategoryId ?? 1;

        // rawDetails is the primary AI context (technical specs + guarantees from Dropi).
        // Fall back to the generic HTML description only when rawDetails is absent.
        const aiContext = (req.body.rawDetails || '').trim() || (req.body.description || '');
        const aiCopy = await generateProductCopy(resolvedName, aiContext);

        // Ensure at least the primary image is saved in the array (fallback for single-image products)
        const resolvedImages = req.body.imagesJson
          || (image ? JSON.stringify([image]) : null);

        const [product, created] = await models.Product.findOrCreate({
          where: { externalId, sourceProvider: 'dropi' },
          defaults: {
            name:           resolvedName,
            image:          image   ?? '',
            description:    aiCopy  ?? description ?? '',
            images:         resolvedImages,
            variants:       req.body.variantsJson ?? null,
            price:          resolvedPrice,
            stock:          stock   ?? null,
            categoryId:     catId,
            businessId:     businessId ?? null,
            showShop:       true,
            isDeleted:      false,
            lastSyncAt:     new Date(),
            sourceProvider: 'dropi',
          },
        });

        if (!created) {
          const update = {
            businessId: businessId ?? null,
            showShop:   true,
            isDeleted:  false,
            lastSyncAt: new Date(),
          };
          if (pvpOverride != null)   update.price = pvpOverride;
          if (image)                 update.image = image;
          if (resolvedImages)        update.images = resolvedImages;
          if (req.body.variantsJson) update.variants = req.body.variantsJson;
          // Only overwrite description if product has none — keeps AI copy on re-import.
          if (!product.description && (aiCopy || description)) {
            update.description = aiCopy ?? description;
          }
          await product.update(update);
        }

        return res.status(200).json({
          action:     created ? 'created' : 'assigned',
          externalId: product.externalId,
          provider:   'dropi',
          productId:  product.id,
          name:       product.name,
        });
      }

      // Effi and other providers handled by importSingleProduct
      const { categoryMap } = req.body;
      const result = await importSingleProduct({
        provider, externalId, pvpOverride, defaultCategoryId, businessId, categoryMap,
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── All other import routes require admin ─────────────────────────────────────

router.use(
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin')
);

// ── POST /api/v1/import/effi ──────────────────────────────────────────────────

router.post(
  '/effi',
  validatorHandler(effiQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      const { page, limit, defaultCategoryId, businessId } = req.query;
      const summary = await importFromEffi({
        page:              Number(page),
        limit:             Number(limit),
        defaultCategoryId: Number(defaultCategoryId),
        businessId:        businessId ? Number(businessId) : null,
        categoryMap:       req.body?.categoryMap ?? {},
      });
      res.status(200).json(summary);
    } catch (error) {
      next(error);
    }
  }
);


// ── PATCH /api/v1/import/sync-stock ──────────────────────────────────────────

router.patch(
  '/sync-stock',
  validatorHandler(syncStockSchema, 'body'),
  async (req, res, next) => {
    try {
      const { externalId, sourceProvider } = req.body;
      const result = await syncProductStock(externalId, sourceProvider);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/import/sync-all ─────────────────────────────────────────────

router.post(
  '/sync-all',
  validatorHandler(syncAllSchema, 'body'),
  async (req, res, next) => {
    try {
      const { provider } = req.body;
      const result = await syncAllStock(provider);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// catalog and dropi-token routes are defined above (before admin middleware) to allow business_owner access

module.exports = router;
