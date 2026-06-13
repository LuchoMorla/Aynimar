'use strict';

const express    = require('express');
const Joi        = require('joi');
const { Op }     = require('sequelize');

const validatorHandler = require('../middlewares/validatorHandler');
const { models }       = require('../libs/sequelize');

const router = express.Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const createCouponSchema = Joi.object({
  businessId:     Joi.number().integer().min(1).required(),
  code:           Joi.string().min(2).max(50).required(),
  type:           Joi.string().valid('PERCENTAGE', 'FIXED_AMOUNT').required(),
  value:          Joi.number().positive().required(),
  minOrderAmount: Joi.number().min(0).allow(null).default(null),
  startDate:      Joi.string().isoDate().allow(null, '').default(null),
  endDate:        Joi.string().isoDate().allow(null, '').default(null),
  isActive:       Joi.boolean().default(true),
});

const validateCouponSchema = Joi.object({
  code:       Joi.string().min(1).max(50).required(),
  cartTotal:  Joi.number().min(0).required(),
  businessId: Joi.number().integer().min(1).allow(null).default(null),
});

// ── GET /api/v1/coupons/business/:businessId ──────────────────────────────────

router.get('/business/:businessId', async (req, res, next) => {
  try {
    const { businessId } = req.params;
    const coupons = await models.Coupon.findAll({
      where: { businessId: Number(businessId) },
      order: [['created_at', 'DESC']],
    });
    res.json(coupons);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/coupons/validate (public) ────────────────────────────────────

router.post(
  '/validate',
  validatorHandler(validateCouponSchema, 'body'),
  async (req, res, next) => {
    try {
      const { code, cartTotal, businessId } = req.body;
      const normalizedCode = code.trim().toUpperCase();

      const where = { code: normalizedCode, isActive: true };
      if (businessId) where.businessId = businessId;

      const coupon = await models.Coupon.findOne({ where });

      if (!coupon) {
        return res.status(404).json({ valid: false, message: 'Código de cupón no encontrado o inactivo.' });
      }

      const today = new Date().toISOString().slice(0, 10);
      if (coupon.startDate && today < coupon.startDate) {
        return res.status(422).json({ valid: false, message: `Este cupón es válido a partir del ${coupon.startDate}.` });
      }
      if (coupon.endDate && today > coupon.endDate) {
        return res.status(422).json({ valid: false, message: 'Este cupón ya expiró.' });
      }
      if (coupon.minOrderAmount !== null && cartTotal < parseFloat(coupon.minOrderAmount)) {
        return res.status(422).json({
          valid: false,
          message: `El monto mínimo de compra para este cupón es $${parseFloat(coupon.minOrderAmount).toFixed(2)}.`,
        });
      }

      let discountAmount;
      if (coupon.type === 'PERCENTAGE') {
        discountAmount = parseFloat((cartTotal * (parseFloat(coupon.value) / 100)).toFixed(2));
      } else {
        discountAmount = Math.min(parseFloat(coupon.value), cartTotal);
      }

      res.json({
        valid:          true,
        discount:       discountAmount,
        type:           coupon.type,
        value:          parseFloat(coupon.value),
        code:           coupon.code,
        businessId:     coupon.businessId,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/coupons ──────────────────────────────────────────────────────

router.post(
  '/',
  validatorHandler(createCouponSchema, 'body'),
  async (req, res, next) => {
    try {
      let { businessId, code, type, value, minOrderAmount, startDate, endDate, isActive } = req.body;

      code = code.trim().toUpperCase().replace(/\s+/g, '');

      const existing = await models.Coupon.findOne({ where: { businessId, code } });
      if (existing) {
        return res.status(409).json({ message: `Ya existe un cupón con el código "${code}" en este negocio.` });
      }

      const coupon = await models.Coupon.create({
        businessId,
        code,
        type,
        value,
        minOrderAmount: minOrderAmount ?? null,
        startDate:      startDate || null,
        endDate:        endDate   || null,
        isActive:       isActive  ?? true,
      });

      res.status(201).json(coupon);
    } catch (error) {
      next(error);
    }
  }
);

// ── PATCH /api/v1/coupons/:id/toggle ─────────────────────────────────────────

router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const coupon = await models.Coupon.findByPk(Number(req.params.id));
    if (!coupon) return res.status(404).json({ message: 'Cupón no encontrado.' });

    await coupon.update({ isActive: !coupon.isActive });
    res.json(coupon);
  } catch (error) {
    next(error);
  }
});

// ── DELETE /api/v1/coupons/:id ────────────────────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const coupon = await models.Coupon.findByPk(Number(req.params.id));
    if (!coupon) return res.status(404).json({ message: 'Cupón no encontrado.' });

    await coupon.destroy();
    res.json({ message: 'Cupón eliminado.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
