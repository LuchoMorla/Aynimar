'use strict';

const express = require('express');
const Joi     = require('joi');

const validatorHandler = require('../middlewares/validatorHandler');
const { models }       = require('../libs/sequelize');

const router = express.Router();

const createReviewSchema = Joi.object({
  productId:    Joi.number().integer().min(1).required(),
  businessId:   Joi.number().integer().allow(null).default(null),
  rating:       Joi.number().integer().min(1).max(5).required(),
  customerName: Joi.string().min(2).max(80).required(),
  city:         Joi.string().max(60).allow('', null).default(null),
  comment:      Joi.string().min(5).max(1000).required(),
});

const queryReviewSchema = Joi.object({
  productId: Joi.number().integer().min(1).required(),
  rating:    Joi.number().integer().min(1).max(5).allow(null).default(null),
  withPhotos: Joi.boolean().truthy('true').falsy('false').default(false),
  page:      Joi.number().integer().min(1).default(1),
  limit:     Joi.number().integer().min(1).max(50).default(10),
});

// ── GET /api/v1/reviews?productId=&rating=&withPhotos=&page=&limit= ───────────
// Public — no auth required

router.get(
  '/',
  validatorHandler(queryReviewSchema, 'query'),
  async (req, res, next) => {
    try {
      const productId  = Number(req.query.productId);
      const rating     = req.query.rating ? Number(req.query.rating) : null;
      const withPhotos = req.query.withPhotos === 'true';
      const page       = Math.max(1, Number(req.query.page)  || 1);
      const limit      = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
      const offset     = (page - 1) * limit;

      const where = { productId };
      if (rating)     where.rating = rating;
      if (withPhotos) where.imagesJson = { [require('sequelize').Op.ne]: null };

      const { count, rows } = await models.Review.findAndCountAll({
        where,
        order:  [['created_at', 'DESC']],
        limit,
        offset,
      });

      // Aggregate stats for the summary block
      const allRatings = await models.Review.findAll({
        where:      { productId },
        attributes: ['rating'],
        raw:        true,
      });

      const total    = allRatings.length;
      const average  = total > 0
        ? (allRatings.reduce((s, r) => s + r.rating, 0) / total).toFixed(1)
        : null;
      const breakdown = [5, 4, 3, 2, 1].map((star) => ({
        star,
        count: allRatings.filter((r) => r.rating === star).length,
      }));

      res.json({
        reviews: rows,
        total:   count,
        page,
        pages:   Math.ceil(count / limit),
        stats: { total, average: average ? parseFloat(average) : null, breakdown },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /api/v1/reviews ──────────────────────────────────────────────────────
// Public — any visitor can submit a review

router.post(
  '/',
  validatorHandler(createReviewSchema, 'body'),
  async (req, res, next) => {
    try {
      const { productId, businessId, rating, customerName, city, comment } = req.body;

      const product = await models.Product.findOne({ where: { id: productId }, attributes: ['id'] });
      if (!product) {
        return res.status(404).json({ message: 'Producto no encontrado.' });
      }

      const review = await models.Review.create({
        productId,
        businessId: businessId ?? null,
        rating,
        customerName: customerName.trim(),
        city:         city?.trim() ?? null,
        comment:      comment.trim(),
        imagesJson:   null,
      });

      res.status(201).json(review);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
