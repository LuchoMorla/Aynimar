'use strict';

// Cola de excepciones de pedidos (solo admin). Contrato: docs/ORDER_AUTOMATION.md.
const express = require('express');
const passport = require('passport');
const Joi = require('joi');
const { checkRoles } = require('../middlewares/authHandler');
const validatorHandler = require('../middlewares/validatorHandler');
const automation = require('../Services/orderAutomationService');

const router = express.Router();
const guard = [passport.authenticate('jwt', { session: false }), checkRoles('admin')];

const listSchema = Joi.object({
  status: Joi.string().valid('open', 'resolved', 'all').default('open'),
  type: Joi.string().valid(...automation.EXCEPTION_TYPES),
  limit: Joi.number().integer().min(1).max(500).default(100),
});
const idSchema = Joi.object({ id: Joi.number().integer().min(1).required() });
const money = Joi.number().min(0).max(100000).precision(2);
const resolveSchema = Joi.object({
  resolution: Joi.string().valid(...Object.keys(automation.RESOLUTIONS)).required(),
  note: Joi.string().max(1000).allow(''),
  dropiOrderId: Joi.string().pattern(/^[A-Za-z0-9_-]{1,100}$/),
  amount: money,
  shippingCost: money,
  providerFees: money,
  dropiCity: Joi.object({
    id: Joi.number().integer().min(1).required(),
    name: Joi.string().max(100).required(),
    departmentId: Joi.number().integer().min(1),
    department: Joi.string().max(100),
  }),
});

router.get('/', ...guard, validatorHandler(listSchema, 'query'), async (req, res, next) => {
  try {
    const { status = 'open', type, limit = 100 } = req.query;
    const items = await automation.listExceptions({ status, type, limit });
    res.json({ items, count: items.length, mode: automation.getConfig().mode });
  } catch (err) { next(err); }
});

router.post('/:id/resolve', ...guard, validatorHandler(idSchema, 'params'), validatorHandler(resolveSchema, 'body'), async (req, res, next) => {
  try {
    res.json(await automation.resolveException(Number(req.params.id), req.body, req.user.sub));
  } catch (err) { next(err); }
});

module.exports = router;
