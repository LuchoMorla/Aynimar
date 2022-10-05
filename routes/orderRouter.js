const express = require('express');

const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');

const OrderService = require('../Services/orderService');
const CustomerService = require('../Services/customerService');
const RecyclerService = require('../Services/recyclerService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getOrderSchema,
  createOrderSchema,
  updateItemSchema,
  addItemSchema,
  getItemSchema
} = require('../schemaODtos/orderSchema');

const router = express.Router();
const service = new OrderService();
const customerService = new CustomerService();
const recyclerService = new RecyclerService();

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const orders = await service.find();
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const order = await service.findOne(id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/userId/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const orders = await service.findByUser(id);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/', 
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(createOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = {
        userId: req.user.sub,
        userRole: req.user.role,
      };
      const haveCustomerId = await customerService.findByUserId(body.userId);
      if (body.userRole === 'recycler' && !haveCustomerId) {
        const findRecycler = await recyclerService.findByUserId(body.userId);
        const newCustomer = await customerService.createCustomerByRecycler(
          findRecycler
        );
        return newCustomer;
      }
      const newOrder = await service.create(body);
      res.status(201).json(newOrder);
    } catch (error) {
      next(error);
    }
  }
);

/* lo elimine por que no me interesa no veo a que se le pueda hacer update
router.patch(
  '/', 
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(updateOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = {
        userId: req.user.sub,
        userRole: req.user.role,
      };

      const newOrder = await service.create(body);
      res.status(201).json(newOrder);
    } catch (error) {
      next(error);
    }
  }
); */

// ITEMS

router.get(
  '/add-item/:id',
  validatorHandler(getItemSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const item = await service.findOneItem(id);
      res.json(item);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/add-item',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(addItemSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newItem = await service.addItem(body);
      res.status(201).json(newItem);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/add-item/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(getItemSchema, 'params'),
  validatorHandler(updateItemSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const updateItem = await service.updateItem(id, body);
      res.status(201).json(updateItem);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/add-item/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(getItemSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleteItem = await service.deleteItem(id);
      res.status(201).json(deleteItem);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;