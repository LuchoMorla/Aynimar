const express = require('express');
const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');

const OrderService = require('../Services/orderService'),
      PaymentService = require('../Services/paymentService'),
      CustomerService = require('../Services/customerService'),
      RecyclerService = require('../Services/recyclerService'),
      WalletService = require('../Services/walletService');
/* const validatorHandler = require('../middlewares/validatorHandler');
const { getOrderSchema } = require('../schemaODtos/orderSchema'),
      { getPaymentSchema } = require('../schemaODtos/paymentSchema'),
      { getWalletSchema } = require('../schemaODtos/walletSchema'); */

const router = express.Router();
const orderService = new OrderService();
const paymentService = new PaymentService();
const walletService = new WalletService();
const customerService = new CustomerService();
const recyclerService = new RecyclerService();

router.get('/my-customer-data',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
  async (req, res, next) => {
    try {
      const user = req.user;
      const customer = await customerService.findByUserId(user.sub);
      res.json(customer);
    } catch (error) {
      next(error);
    }
  }
);

router.post('/my-customer-data',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
  async (req, res, next) => {
    try {
      const user = req.user;
      const findRecycler = await recyclerService.findByUserId(user.sub);
      const customer = await customerService.createCustomerByRecycler(findRecycler);
      res.json(customer);
    } catch (error) {
      next(error);
    }
  }
);

router.get('/my-recycler-data',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
  async (req, res, next) => {
    try {
      const user = req.user;
      const recycler = await recyclerService.findByUserId(user.sub);
      res.json(recycler);
    } catch (error) {
      next(error);
    }
  }
);

router.post('/my-recycler-data',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
  async (req, res, next) => {
    try {
      const user = req.user;
      const findRecycler = await customerService.findByUserId(user.sub);
      const recycler = await recyclerService.createRecyclerByCustomer(findRecycler);
      res.json(recycler);
    } catch (error) {
      next(error);
    }
  }
);

router.get('/my-orders',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
/*   validatorHandler(getOrderSchema, 'params'), */
  async (req, res, next) => {
    try {
      const user = req.user;
      const orders = await orderService.findByUser(user.sub);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

router.get('/my-credits',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
/*   validatorHandler(getWalletSchema, 'params'), */
  async (req, res, next) => {
    try {
      const user = req.user;
      const credit = await walletService.findByUser(user.sub);
      res.json(credit);
    } catch (error) {
      next(error);
    }
  }
);

router.get('/mis-reciclajes',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
/*   validatorHandler(getPaymentSchema, 'params'), */
  async (req, res, next) => {
    try {
      const user = req.user;
      const payments = await paymentService.findByUser(user.sub);
      res.json(payments);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;