const express = require('express');

const PaymentService = require('../Services/paymentService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getPaymentSchema,
  createPaymentSchema,
  addCommoditieSchema,
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
  validatorHandler(createPaymentSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newPayment = await service.create(body);
      res.status(201).json(newPayment);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/add-item',
  validatorHandler(addCommoditieSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newCommoditie = await service.addCommoditie(body);
      res.status(201).json(newCommoditie);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;