const express = require('express');
const passport = require('passport');

const WasteCategoryService = require('../Services/wasteCategoryService');
const validatorHandler = require('../middlewares/validatorHandler');
const { checkRoles } = require('../middlewares/authHandler');
const {
  createWasteCategorySchema,
  updateWasteCategorySchema,
  getWasteCategorySchema,
} = require('../schemaODtos/wasteCategorySchema');

const router = express.Router();
const service = new WasteCategoryService();

router.get(
  '/',
  async (req, res, next) => {
    try {
      const wasteCategories = await service.find();
      res.json(wasteCategories);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  validatorHandler(getWasteCategorySchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const wasteCategory = await service.findOne(id);
      res.json(wasteCategory);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  passport.authenticate('jwt', { session: false }),
  validatorHandler(createWasteCategorySchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newWasteCategory = await service.create(body);
      res.status(201).json(newWasteCategory);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getWasteCategorySchema, 'params'),
  validatorHandler(updateWasteCategorySchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const wasteCategory = await service.update(id, body);
      res.json(wasteCategory);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getWasteCategorySchema, 'params'),
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

module.exports = router;
