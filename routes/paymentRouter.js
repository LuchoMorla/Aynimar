const express = require('express');
const passport = require('passport');
const { checkRoles, assertUserAccess } = require('../middlewares/authHandler');
const PaymentService = require('../Services/paymentService');
const CustomerService = require('../Services/customerService');
const RecyclerService = require('../Services/recyclerService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getPaymentSchema,
  createPaymentSchema,
  addCommoditySchema,
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
      // IDOR: solo el pago propio (admin, cualquiera).
      const payment = await service.findOneForUser(id, req.user);
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
  validatorHandler(getPaymentSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      // IDOR: solo los pagos propios (admin, los de cualquiera).
      assertUserAccess(id, req.user);
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
        userRole: req.user.role,
      };
      const haveRecyclerId = await recyclerService.findByUserId(body.userId);
      if (body.userRole === 'customer' && !haveRecyclerId) {
        const findCostumer = await customerService.findByUserId(body.userId);
        // R8: antes devolvía el Recycler y el front guardaba su id como
        // paymentId → el primer add-commodity fallaba. Ahora se crea el perfil
        // y se continúa para devolver siempre un Payment.
        await recyclerService.createRecyclerByCustomer(findCostumer);
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
      // IDOR: solo se añade material a un pago propio (antes, a cualquiera).
      await service.findOneForUser(body.paymentId, req.user);
      const newCommodity = await service.addCommodity(body);
      res.status(201).json(newCommodity);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;