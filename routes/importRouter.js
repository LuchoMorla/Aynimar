'use strict';

const express  = require('express');
const passport = require('passport');
const Joi      = require('joi');

const { Op }               = require('sequelize');
const { checkRoles }       = require('../middlewares/authHandler');
const validatorHandler     = require('../middlewares/validatorHandler');
const { importFromEffi, importSingleProduct, syncProductStock, syncAllStock } = require('../integrations/importService');
const { fetchProductsFromEffi } = require('../integrations/effi/effiAdapter');
const { fetchDropiProductById }             = require('../integrations/dropi/dropiAdapter');
const { searchByText, searchByAI, searchByImage } = require('../integrations/dropi/dropiSearchService');
const { generateProductCopy }               = require('../integrations/aiCopyService');
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
  showShop:          Joi.boolean().default(false),
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
  // NOTE: errors handled inline (not via next) to guarantee CORS headers survive.
  async (req, res) => {
    try {
      const provider = String(req.query.provider ?? 'dropi');
      const page     = Number(req.query.page)    || 1;
      const limit    = Number(req.query.limit)   || 20;
      const keyword  = req.query.keyword ? String(req.query.keyword).trim() : '';

      if (provider === 'dropi') {
        const priceMin    = req.query.priceMin    !== undefined ? Number(req.query.priceMin)    : null;
        const priceMax    = req.query.priceMax    !== undefined ? Number(req.query.priceMax)    : null;
        const categoryId  = req.query.categoryId  !== undefined ? Number(req.query.categoryId)  : null;
        const userVerified = req.query.userVerified === 'true';
        const userPremium  = req.query.userPremium  === 'true';
        const minStock     = req.query.minStock    !== undefined ? Number(req.query.minStock)    : null;
        const searchMode  = req.query.mode ?? 'text'; // 'text' | 'ai'

        // ── With keyword → query the LIVE Dropi catalog ─────────────────────
        if (keyword) {
          const opts = { page, limit, categoryId, priceMin, priceMax, userVerified, userPremium };
          let result = searchMode === 'ai'
            ? await searchByAI(keyword, opts)
            : await searchByText(keyword, opts);

          // fetchDropiCatalog nunca lanza — pero si regresa dropiError, informar al cliente.
          if (result.dropiError) {
            const code = result.dropiError;
            if (code === 'NO_TOKEN') {
              return res.status(503).json({ error: 'Token de Dropi no configurado.', code });
            }
            if (code === 'AUTH_DENIED') {
              return res.status(503).json({ error: 'Token de Dropi expirado o inválido.', code });
            }
            return res.status(500).json({ error: 'Error de comunicación con Dropi.', code, detail: result.message });
          }

          // Client-side stock filter applied after Dropi returns results
          if (minStock != null && !isNaN(minStock) && minStock > 0) {
            result = {
              ...result,
              products: result.products.filter((p) => p.stock == null || p.stock >= minStock),
            };
          }
          return res.json(result);
        }

        // ── No keyword → browse already-imported products from local DB ──────
        const where = { sourceProvider: 'dropi', isDeleted: false };
        if (priceMin != null && !isNaN(priceMin)) where.price = { ...(where.price ?? {}), [Op.gte]: priceMin };
        if (priceMax != null && !isNaN(priceMax)) where.price = { ...(where.price ?? {}), [Op.lte]: priceMax };

        const offset = (page - 1) * limit;
        const { count, rows } = await models.Product.findAndCountAll({
          where,
          limit,
          offset,
          order:    [['id', 'DESC']],
          subQuery: false,
        });

        const products = rows.map((p) => {
          let imagesArray = []; try { imagesArray = JSON.parse(p.images ?? '[]'); } catch {}
          let variants    = []; try { variants    = JSON.parse(p.variants ?? '[]'); } catch {}
          return {
            externalId:      p.externalId,
            title:           p.name,
            description:     p.description ?? '',
            rawDetails:      '',
            warehouses:      [],
            image:           imagesArray[0] ?? p.image ?? null,
            imagesArray,
            variants,
            price:           p.price ?? 0,
            retailPrice:     null,
            stock:           p.stock ?? null,
            sku:             p.externalId,
            alreadyImported: p.businessId != null,
          };
        });

        return res.json({ products, total: count, page });
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
      console.error('[/catalog] Error inesperado:', error.message);
      return res.status(500).json({ error: 'Error interno del servidor.', detail: error.message });
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

// ── GET /api/v1/import/prepare?productId=xxx ─────────────────────────────────
// Pre-import staging: fetch full Dropi product details for admin review/edit.
// Returns rawDetails + imagesArray explicitly so the admin can edit or send to AI
// before committing to the local DB via POST /product.
// Errors handled inline — CORS headers guaranteed.

router.get(
  '/prepare',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res) => {
    const { productId } = req.query;
    if (!productId || !/^\d+$/.test(String(productId))) {
      return res.status(400).json({ message: 'Query param productId (entero) requerido.' });
    }
    try {
      const p = await fetchDropiProductById(productId);
      return res.json({
        status:  'ready_for_review',
        product: {
          externalId:  p.externalId,
          title:       p.title,
          description: p.description,
          rawDetails:  p.rawDetails,   // texto técnico crudo → fuente primaria de IA
          image:       p.image,
          imagesArray: p.imagesArray,
          variants:    p.variants,
          price:       p.price,
          retailPrice: p.retailPrice,
          stock:       p.stock,
          sku:         p.sku,
        },
      });
    } catch (err) {
      if (err.code === 'DROPI_TOKEN_EXPIRED' || err.message?.includes('Sin token') || err.message?.includes('token de sesión')) {
        return res.status(503).json({ message: 'Token de Dropi expirado o no configurado.', code: 'DROPI_TOKEN_EXPIRED' });
      }
      console.error('[/prepare] Error:', err.message);
      return res.status(500).json({ message: err.message ?? 'Error al obtener producto de Dropi.' });
    }
  }
);

// ── GET /api/v1/import/dropi-preview/:productId ───────────────────────────────
// Fetches a single Dropi product by ID and returns it normalized for preview.
// Does NOT save to DB — the frontend calls POST /product to confirm the import.

router.get(
  '/dropi-preview/:productId',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { productId } = req.params;
      if (!productId || !/^\d+$/.test(productId)) {
        return res.status(400).json({ message: 'productId debe ser un número entero.' });
      }
      const product = await fetchDropiProductById(productId);
      return res.json(product);
    } catch (err) {
      if (
        err.code === 'DROPI_TOKEN_EXPIRED' ||
        err.message?.includes('Sin token') ||
        err.message?.includes('token de sesión')
      ) {
        return res.status(503).json({
          message: 'Token de Dropi expirado o no configurado.',
          code: 'DROPI_TOKEN_EXPIRED',
        });
      }
      next(err);
    }
  }
);

// ── POST /api/v1/import/image-search ─────────────────────────────────────────
// Receives { imageBase64, page, limit } — routes to Dropi's native image-similarity
// search engine directly, no external services.
// NOTE: errors are handled inline (not via next(error)) to guarantee that the CORS
// headers set by app.use(cors()) survive in the error response.

router.post(
  '/image-search',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res) => {
    try {
      const { imageBase64, page = 1, limit = 24 } = req.body ?? {};
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.status(400).json({ message: 'imageBase64 (string) requerido en el body.' });
      }
      const result = await searchByImage(imageBase64, { page: Number(page), limit: Number(limit) });
      return res.json(result);
    } catch (err) {
      const httpStatus = err.dropiStatus ?? err.response?.status ?? null;
      const message    = err.message ?? 'Error en la búsqueda por imagen.';
      console.error('[/image-search] Error:', message, '| dropiStatus:', httpStatus);
      if (httpStatus === 401 || httpStatus === 403) {
        return res.status(503).json({ message: 'Token de Dropi expirado o inválido.', code: 'DROPI_TOKEN_EXPIRED' });
      }
      return res.status(500).json({ message });
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
        const showShop      = req.body.showShop ?? false;

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
            showShop:       showShop,
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
