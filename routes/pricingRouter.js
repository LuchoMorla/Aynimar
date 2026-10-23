'use strict';

// Cotización de precio para el panel — solo admin, sin estado, nunca escribe.
// Fórmula oficial: Services/financeContribution.quotePrice (ops-ceo-cto/finanzas/formula-precio.md).
const express = require('express');
const passport = require('passport');
const Joi = require('joi');

const { checkRoles } = require('../middlewares/authHandler');
const validatorHandler = require('../middlewares/validatorHandler');
const { quotePrice } = require('../Services/financeContribution');

const router = express.Router();

const quoteSchema = Joi.object({
  coste: Joi.number().min(0).max(100000).required(),
  flete: Joi.number().min(0).max(10000).required(),
  pvp: Joi.number().positive().max(1000000),
});

router.post('/quote',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(quoteSchema, 'body'),
  (req, res, next) => {
    try {
      const { value } = quoteSchema.validate(req.body); // valores ya convertidos por Joi
      res.json(quotePrice(value));
    } catch (err) {
      next(err);
    }
  });

module.exports = router;
module.exports.quoteSchema = quoteSchema;
