'use strict';

const express  = require('express');
const passport = require('passport');
const Joi      = require('joi');

const { checkRoles }       = require('../middlewares/authHandler');
const validatorHandler     = require('../middlewares/validatorHandler');
const { importFromEffi, importSingleProduct, syncProductStock, syncAllStock } = require('../integrations/importService');
const { fetchProductsFromEffi } = require('../integrations/effi/effiAdapter');
const { fetchDropiCatalog }     = require('../integrations/dropi/dropiAdapter');
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
  provider:          Joi.string().valid('effi').required(),
  externalId:        Joi.string().required(),
  pvpOverride:       Joi.number().positive().allow(null).default(null),
  defaultCategoryId: Joi.number().integer().min(1).default(1),
  businessId:        Joi.number().integer().allow(null).default(null),
  categoryMap:       Joi.object().default({}),
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
  checkRoles('admin', 'business-owner'),
  async (req, res, next) => {
    try {
      const provider = String(req.query.provider ?? 'dropi');
      const page     = Number(req.query.page)    || 1;
      const limit    = Number(req.query.limit)   || 20;
      const keyword  = req.query.keyword ? String(req.query.keyword).trim() : '';

      if (provider === 'dropi') {
        const { products, total } = await fetchDropiCatalog({ page, limit, keyword });

        const externalIds = products.map((p) => p.externalId).filter(Boolean);
        const existing    = await models.Product.findAll({
          where: { externalId: externalIds, sourceProvider: 'dropi' },
          attributes: ['externalId'],
        });
        const existingSet = new Set(existing.map((p) => p.externalId));

        const annotated = products.map((p) => ({
          ...p,
          alreadyImported: existingSet.has(p.externalId),
        }));

        return res.json({ products: annotated, total, page });
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

// ── POST /api/v1/import/product ───────────────────────────────────────────────
// Single-product import from Effi by externalId, with optional PVP override.

router.post(
  '/product',
  validatorHandler(importProductSchema, 'body'),
  async (req, res, next) => {
    try {
      const { provider, externalId, pvpOverride, defaultCategoryId, businessId, categoryMap } = req.body;
      const result = await importSingleProduct({
        provider, externalId, pvpOverride,
        defaultCategoryId, businessId, categoryMap,
      });
      res.status(200).json(result);
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

// catalog route is defined above (before admin middleware) to allow business-owner access

module.exports = router;
