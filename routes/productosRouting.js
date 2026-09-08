const express = require('express');
const passport = require('passport');
const boom = require('@hapi/boom');

const { checkRoles } = require('../middlewares/authHandler');

const ProductsService = require('./../Services/productServices');

const validatorHandler = require('../middlewares/validatorHandler');
const {
  createProductSchema,
  updateProductSchema,
  getProductSchema,
  queryProductSchema,
  previewPricingSchema,
  applyEnginePricingSchema,
} = require('../schemaODtos/productSchema');
const { previewEnginePrice, applyEnginePrice, APPLY_STATUS } = require('../Services/productPricingApplyService');

const router = express.Router();
const service = new ProductsService();

router.get(
  '/',
  validatorHandler(queryProductSchema, 'query'),
  async (req, res, next) => {
    try {
      const products = await service.find(req.query);
      res.json(products);
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /products/merchant-status — ping Google auth, no product needed ──────
// Must be registered BEFORE /:id to avoid the wildcard swallowing 'merchant-status'.
router.get(
  '/merchant-status',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      if (!process.env.GOOGLE_MERCHANT_ID) {
        return res.status(503).json({ status: 'not_configured', message: 'GOOGLE_MERCHANT_ID not set' });
      }
      const { pingMerchant } = require('../libs/google-merchant');
      const account = await pingMerchant();
      res.json({ status: 'live', account });
    } catch (error) {
      res.status(502).json({ status: 'error', message: error.message });
    }
  }
);

router.get(
  '/:id',
  validatorHandler(getProductSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const product = await service.findOne(id);
      // Lectura pública: un producto borrado no existe para la tienda.
      // El storefront (getStaticProps) traduce este 404 a notFound → página 404.
      // update()/delete() usan service.findOne directamente y NO pasan por aquí.
      if (product.isDeleted) {
        throw boom.notFound('Product not found');
      }
      res.json(product);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', "business_owner"),
  validatorHandler(createProductSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newProduct = await service.create(body);
      res.status(201).json(newProduct);
    } catch (error) {
      next(error);
    }
  }
);

// ── PATCH /api/v1/products/:id/price — inline price edit ─────────────────────
router.patch(
  '/:id/price',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const id    = Number(req.params.id);
      const price = Number(req.body.price);
      if (!id || isNaN(price) || price < 0) {
        return res.status(400).json({ message: 'price debe ser un número >= 0.' });
      }
      const result = await service.update(id, { price });
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/products/:id/pricing/preview — cálculo del Pricing Engine, ──
// 100% read-only. Nunca escribe product.price ni ningún otro campo.
router.post(
  '/:id/pricing/preview',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getProductSchema, 'params'),
  validatorHandler(previewPricingSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { notFound, result } = await previewEnginePrice(id, req.body);
      if (notFound) {
        return res.status(404).json({ message: `Producto ${id} no encontrado.` });
      }
      res.json({ applied: false, result });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/products/:id/pricing/apply-engine — única vía autorizada ────
// de pricingSource='engine'. Acción humana explícita — nunca automática.
router.post(
  '/:id/pricing/apply-engine',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getProductSchema, 'params'),
  validatorHandler(applyEnginePricingSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { notFound, applied, status, result } = await applyEnginePrice(id, req.body);

      if (notFound) {
        return res.status(404).json({ message: `Producto ${id} no encontrado.` });
      }
      if (status === APPLY_STATUS.PRICE_DRIFTED) {
        return res.status(409).json({
          applied: false,
          status,
          message: 'El precio cambió desde el preview — revisa el resultado y vuelve a intentar.',
          result,
        });
      }
      if (!applied) {
        return res.status(422).json({
          applied: false,
          status,
          message: 'No se pudo calcular un precio económicamente válido para este producto.',
          result,
        });
      }
      res.json({ applied: true, status, result });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', "business_owner"),
  validatorHandler(getProductSchema, 'params'),
  validatorHandler(updateProductSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const product = await service.update(id, body);
      res.json(product);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', "business_owner"),
  validatorHandler(getProductSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      await service.delete(id);
      res.status(201).json({ id });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /products/:id/validate-sync — full agent: validate + Telegram report ─
router.post(
  '/:id/validate-sync',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getProductSchema, 'params'),
  async (req, res, next) => {
    try {
      const { validateProductSync } = require('../Services/merchantSyncService');
      const result = await validateProductSync(Number(req.params.id));
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /products/:id/merchant-preview — validate without sending ─────────────
router.get(
  '/:id/merchant-preview',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getProductSchema, 'params'),
  async (req, res, next) => {
    try {
      const { validateProductForMerchant } = require('../libs/google-merchant');
      const product = await service.findOne(req.params.id);
      const report  = validateProductForMerchant(product);
      res.json(report);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /products/:id/sync-merchant — send to Google (gated by env var) ─────
router.post(
  '/:id/sync-merchant',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getProductSchema, 'params'),
  async (req, res, next) => {
    try {
      if (!process.env.GOOGLE_MERCHANT_ID) {
        return res.status(503).json({ message: 'Google Merchant integration not configured' });
      }
      const { syncProductToMerchant } = require('../libs/google-merchant');
      const product = await service.findOne(req.params.id);
      const result  = await syncProductToMerchant(product);
      res.json({ synced: true, merchantId: result.id });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
