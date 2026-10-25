const express = require('express');
const passport = require('passport');

const WasteService = require('./../Services/wasteService');
const { checkRoles } = require('../middlewares/authHandler');
const OrderService = require('../Services/orderService');

const orderService = new OrderService();

const validatorHandler = require('../middlewares/validatorHandler');
const {
  createWasteSchema,
  updateWasteSchema,
  getWasteSchema,
  queryWasteSchema,
} = require('../schemaODtos/wasteSchema');

const router = express.Router();
const service = new WasteService();

router.get(
  '/',
  validatorHandler(queryWasteSchema, 'query'),
  async (req, res, next) => {
    try {
      const wastes = await service.find(req.query);
      res.json(wastes);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  validatorHandler(getWasteSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const waste = await service.findOne(id);
      res.json(waste);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(createWasteSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      // IDOR: un business_owner solo crea residuos en su propio negocio.
      if (body.businessId != null) await orderService.assertBusinessAccess(body.businessId, req.user);
      const newWaste = await service.create(body);
      res.status(201).json(newWaste);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getWasteSchema, 'params'),
  validatorHandler(updateWasteSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      // IDOR: un business_owner solo edita residuos de su negocio (admin, todos).
      await orderService.assertBusinessAccess((await service.findOne(id)).businessId, req.user);
      const waste = await service.update(id, body);
      res.json(waste);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getWasteSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      // IDOR: un business_owner solo borra residuos de su negocio (admin, todos).
      await orderService.assertBusinessAccess((await service.findOne(id)).businessId, req.user);
      await service.delete(id);
      res.status(201).json({ id });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
