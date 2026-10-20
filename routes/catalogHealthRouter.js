'use strict';

// Salud del catálogo — solo admin. Contrato en docs/CATALOG_HEALTH.md.
const express = require('express');
const passport = require('passport');
const Joi = require('joi');

const { checkRoles } = require('../middlewares/authHandler');
const validatorHandler = require('../middlewares/validatorHandler');
const service = require('../Services/catalogHealthService');
const candidates = require('../Services/supplierCandidateService');

const router = express.Router();

router.use(passport.authenticate('jwt', { session: false }), checkRoles('admin'));

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) { next(err); }
};

router.get('/',
  validatorHandler(Joi.object({ status: Joi.string().valid('open', 'decided', 'dismissed', 'all') }), 'query'),
  wrap(async (req, res) => res.json(await service.list(req.query.status || 'open'))));

router.post('/scan', wrap(async (req, res) => res.json(await service.scan())));

router.post('/import',
  validatorHandler(service.importSchema, 'body'),
  wrap(async (req, res) => res.json(await service.importRows(req.body))));

// Proveedores alternativos (docs/SUPPLIER_CANDIDATES.md). Nunca tocan el producto ni pedidos.
router.get('/supplier-candidates',
  validatorHandler(Joi.object({
    productId: Joi.number().integer().positive(),
    status: Joi.string().valid(...candidates.STATUSES, 'all'),
  }), 'query'),
  wrap(async (req, res) => res.json(await candidates.list({ productId: req.query.productId ? Number(req.query.productId) : undefined, status: req.query.status }))));

router.post('/supplier-candidates/:id/status',
  validatorHandler(Joi.object({ id: Joi.number().integer().positive().required() }), 'params'),
  validatorHandler(candidates.statusSchema, 'body'),
  wrap(async (req, res) => res.json(await candidates.setStatus(Number(req.params.id), req.body, req.user.sub))));

router.post('/:id/decision',
  validatorHandler(Joi.object({ id: Joi.number().integer().positive().required() }), 'params'),
  validatorHandler(service.decisionSchema, 'body'),
  wrap(async (req, res) => res.json(await service.decide(Number(req.params.id), req.body, req.user.sub))));

module.exports = router;
