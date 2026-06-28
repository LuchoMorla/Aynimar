'use strict';

const express = require('express');
const passport = require('passport');
const Joi = require('joi');

const { checkRoles } = require('../middlewares/authHandler');
const validatorHandler = require('../middlewares/validatorHandler');
const CommissionService = require('../Services/commissionService');

const router = express.Router();
const service = new CommissionService();

const liquidateSchema = Joi.object({
  paymentWasteId: Joi.number().integer().positive().required(),
  grossAmount:    Joi.number().positive().precision(2).required(),
});

const transactionsQuerySchema = Joi.object({
  page:  Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

// ── POST /api/v1/commissions/liquidate ───────────────────────────────────────
// Admin-only. Validates a recycling sale and credits the user's wallet.
// The 30% commission is applied server-side; the client sends only the
// paymentWasteId and the agreed gross amount.
router.post(
  '/liquidate',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(liquidateSchema, 'body'),
  async (req, res, next) => {
    try {
      const { paymentWasteId, grossAmount } = req.body;
      const summary = await service.liquidate(paymentWasteId, grossAmount);
      res.status(201).json(summary);
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /api/v1/commissions/my-transactions ──────────────────────────────────
// Authenticated user. Returns their own wallet transaction history.
router.get(
  '/my-transactions',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(transactionsQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const { page, limit } = req.query;
      const data = await service.getTransactionsByUser(userId, {
        page:  parseInt(page, 10),
        limit: parseInt(limit, 10),
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  }
);

// ── GET /api/v1/commissions/finance-summary ──────────────────────────────────
// Admin-only. Aggregated stats for the FinancePanel dashboard.
router.get(
  '/finance-summary',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      const summary = await service.getFinanceSummary();
      res.json(summary);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
