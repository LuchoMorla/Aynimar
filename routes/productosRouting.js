const express = require('express');
const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');

const ProductsService = require('./../Services/productServices');

const validatorHandler = require('../middlewares/validatorHandler');
const {
  createProductSchema,
  updateProductSchema,
  getProductSchema,
  queryProductSchema,
} = require('../schemaODtos/productSchema');

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
