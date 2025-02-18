const express = require('express');
const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');
const BusinessOwnerService = require('../Services/businessOwnerService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  createBusinessOwnerSchema,
  updateBusinessOwnerSchema,
  getBusinessOwnerSchema,
  createBusinessOwnerUserIdSchema,
} = require('../schemaODtos/businessOwnerSchema');

const router = express.Router();
const service = new BusinessOwnerService();

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
  validatorHandler(getBusinessOwnerSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const customer = await service.findOne(id);
      res.json(customer);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/by-user/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getBusinessOwnerSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const customer = await service.findByUserId(+id);
      res.json(customer);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  validatorHandler(createBusinessOwnerSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      res.status(201).json(await service.create(body));
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/by-user',
  validatorHandler(createBusinessOwnerUserIdSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      res.status(201).json(await service.createByUser(body));
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  validatorHandler(updateBusinessOwnerSchema, 'body'),
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
  async (req, res, next) => {
    try {
      const { id } = req.params;
      res.status(200).json(await service.delete(id));
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
