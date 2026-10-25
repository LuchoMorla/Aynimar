const express = require('express');

const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');
const OffersService = require('../Services/offersService');
const OrderService = require('../Services/orderService');
const validatorHandler = require('../middlewares/validatorHandler');
const { paramsOfferSchema, updateOfferSchema } = require('../schemaODtos/offersSchema');

const router = express.Router();
const service = new OffersService();
const orderService = new OrderService();

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      const offers = await service.find();
      res.json(offers);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(paramsOfferSchema, "params"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const offer = await service.findOneForUser(id, req.user);
      res.json(offer);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(paramsOfferSchema, "params"),
  validatorHandler(updateOfferSchema, "body"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      await service.findOneForUser(id, req.user); // IDOR (R4)
      const offer = await service.update(id, req.body);
      res.json(offer);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(paramsOfferSchema, "params"),

  async (req, res, next) => {
    try {
      const { id } = req.params;
      await service.findOneForUser(id, req.user); // IDOR (R4)
      const offer = await service.delete(id);
      res.json(offer);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/by-business/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      await orderService.assertBusinessAccess(id, req.user); // IDOR (R4)
      const offers = await service.findBusiness(id);
      res.json(offers);
    } catch (error) {
      next(error);
    }
  }
);


module.exports = router;
