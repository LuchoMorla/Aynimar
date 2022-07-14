const express = require('express');
const passport = require('passport');
const OrderService = require('../Services/orderService');
const CustomerService = require('../Services/customerService');
const RecyclerService = require('../Services/recyclerService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getOrderSchema,
  createOrderSchema,
  addItemSchema,
} = require('../schemaODtos/orderSchema');

const router = express.Router();
const service = new OrderService();
const customerService = new CustomerService();
const recyclerService = new RecyclerService();


router.get(
  '/:id',
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

router.post(
  '/',
  passport.authenticate('jwt', {session: false}),
  validatorHandler(createOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = {
        userId: req.user.sub,
        userRole: req.user.role
      }
      const haveCustomerId = await customerService.findByUserId(body.userId);
      if (body.userRole === 'recycler' && !haveCustomerId) {
        const findRecycler = await recyclerService.findByUserId(body.userId);
/*         if (!haveCustomerId) { */
          const newCustomer = await customerService.createCustomerByRecycler(findRecycler);
          return newCustomer;
/*         } */
      }
      const newOrder = await service.create(body);
      res.status(201).json(newOrder);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/add-item',
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

module.exports = router;