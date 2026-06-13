const express = require('express');
const passport = require('passport');
const { Op } = require('sequelize');

const { checkRoles } = require('../middlewares/authHandler');

const BusinessService = require('../Services/businessService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  createBusinessSchema,
  updateBusinessSchema,
} = require('../schemaODtos/businessSchema');
const { models } = require('../libs/sequelize');

const router = express.Router();
const service = new BusinessService();

// ── GET /api/v1/business/:id/products ────────────────────────────────────────
// Returns paginated products assigned to a business, with search + filter support.

router.get(
  '/:id/products',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const businessId = parseInt(req.params.id, 10);
      if (!businessId || isNaN(businessId)) {
        return res.status(400).json({ message: 'ID de negocio inválido.' });
      }

      const { search, category, status, stock, page = 1, limit = 20 } = req.query;

      // Strict isolation: ONLY this business's products, never a global dump.
      const where = { businessId, isDeleted: false };

      if (search) {
        // Search by name OR SKU (externalId) so merchants can find Dropi imports by code.
        where[Op.or] = [
          { name:       { [Op.iLike]: `%${search}%` } },
          { externalId: { [Op.iLike]: `%${search}%` } },
        ];
      }
      if (category)            where.categoryId = parseInt(category, 10);
      if (status === 'active')   where.showShop = true;
      if (status === 'inactive') where.showShop = false;
      // Correct Sequelize null-check syntax inside Op.or
      if (stock === 'available') where.stock = { [Op.gt]: 0 };
      if (stock === 'out')       where.stock = { [Op.or]: [{ [Op.lte]: 0 }, null] };

      const pageNum  = Math.max(1, parseInt(page,  10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset   = (pageNum - 1) * limitNum;

      const { count, rows } = await models.Product.findAndCountAll({
        where,
        include: [{ association: 'category', required: false }],
        limit:   limitNum,
        offset,
        order:   [['id', 'DESC']],
        subQuery: false,
      });

      res.json({
        products: rows,
        total:    count,
        page:     pageNum,
        pages:    Math.ceil(count / limitNum),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      res.json(await service.find());
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const business = await service.findOne(id);
      res.json(business);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(createBusinessSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      res.status(201).json(await service.create(body));
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(updateBusinessSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      res.status(201).json(await service.update(id, body));
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      await service.delete(id);
      res.status(200).json({
        id,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
