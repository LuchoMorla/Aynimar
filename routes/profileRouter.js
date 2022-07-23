const express = require('express');
const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');

const OrderService = require('../Services/orderService');
const validatorHandler = require('../middlewares/validatorHandler');
const { getOrderSchema } = require('../schemaODtos/orderSchema');

const router = express.Router();
const service = new OrderService();

router.get('/my-orders',
  passport.authenticate('jwt', {session: false}),
  checkRoles('admin', 'recycler', 'customer'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const user = req.user;
      const orders = await service.findByUser(user.sub);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;