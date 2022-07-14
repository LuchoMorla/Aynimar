const express = require('express');

const passport = require('passport');
const PaymentService = require('../Services/paymentService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getPaymentSchema,
  createPaymentSchema,
  addCommoditySchema,
} = require('../schemaODtos/paymentSchema');

const router = express.Router();
const service = new PaymentService();

router.get(
  '/:id',
  validatorHandler(getPaymentSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const payment = await service.findOne(id);
      res.json(payment);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  validatorHandler(createPaymentSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = {
        userId: req.user.sub
      }
      const newPayment = await service.create(body);
      res.status(201).json(newPayment);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/add-commodity',
  validatorHandler(addCommoditySchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newCommodity = await service.addCommodity(body);
      res.status(201).json(newCommodity);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;