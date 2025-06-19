const express = require('express');

const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');
const PaymentService = require('../Services/paymentService');
const CustomerService = require('../Services/customerService');
const RecyclerService = require('../Services/recyclerService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getPaymentSchema,
  createPaymentSchema,
  addCommoditySchema,
  updatePaymentSchema,
  deletePaymentSchema,
  deleteCommoditySchema,
} = require('../schemaODtos/paymentSchema');

const router = express.Router();
const service = new PaymentService();
const customerService = new CustomerService();
const recyclerService = new RecyclerService();

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      const payments = await service.find();
      res.json(payments);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
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

router.get(
  '/userId/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const payments = await service.findByUser(id);
      res.json(payments);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(createPaymentSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = {
        userId: req.user.sub,
        userRole: req.user.role
      }

      const haveRecyclerId = await recyclerService.findByUserId(body.userId);
      if (body.userRole === 'customer' && !haveRecyclerId) {
        const findCostumer = await customerService.findByUserId(body.userId);
        const newRecycler = await recyclerService.createRecyclerByCustomer(findCostumer);
        return newRecycler;
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
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
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

// Actualizar un pago
router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(getPaymentSchema, 'params'),
  validatorHandler(updatePaymentSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const changes = req.body;
      const updatedPayment = await service.update(id, changes);
      res.json(updatedPayment);
    } catch (error) {
      next(error);
    }
  }
);

// Eliminar un pago
router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(deletePaymentSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      await service.delete(id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

// Eliminar una commodity de un pago
router.delete(
  '/:paymentId/commodity/:commodityId',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(deleteCommoditySchema, 'params'),
  async (req, res, next) => {
    try {
      const { paymentId, commodityId } = req.params;
      const result = await service.removeCommodity(paymentId, commodityId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;