'use strict';

// Smart Shipping (Fase B) — cotización de envío para el carrito del usuario.
// Detrás de app_settings.smart_shipping (apagado → {enabled:false, fallback:'A coordinar'}).
// El cliente NO envía precios, pesos ni productos: todo se lee de BD.
const express = require('express');
const passport = require('passport');
const Joi = require('joi');

const { checkRoles } = require('../middlewares/authHandler');
const validatorHandler = require('../middlewares/validatorHandler');
const { createQuote } = require('../Services/shippingQuoteService');

const router = express.Router();

const quoteSchema = Joi.object({
  orderId: Joi.number().integer().min(1).max(2147483647).required(),
  city: Joi.string().trim().min(2).max(120).required(),
  department: Joi.string().trim().max(120).allow('').optional(),
  paymentMethod: Joi.string().valid('cod', 'deuna').required(),
});

router.post('/quotes',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(quoteSchema, 'body'),
  async (req, res, next) => {
    try {
      const { orderId, city, department, paymentMethod } = req.body;
      res.json(await createQuote({ orderId, userId: req.user.sub, city, department, paymentMethod }));
    } catch (err) {
      next(err);
    }
  });

module.exports = router;
module.exports.quoteSchema = quoteSchema;
