'use strict';
/**
 * /api/v1/social — calendario editorial y panel de publicación (solo admin, JWT).
 * Publicar nunca se dispara desde aquí: solo la aprobación por Telegram encola.
 * Ver docs/SOCIAL_PUBLISHER.md.
 */
const express = require('express');
const passport = require('passport');
const Joi = require('joi');
const { checkRoles } = require('../middlewares/authHandler');
const validatorHandler = require('../middlewares/validatorHandler');
const svc = require('../Services/socialPublisherService');
const { NETWORKS, CHANNELS } = require('../integrations/social');

const router = express.Router();
router.use(passport.authenticate('jwt', { session: false }), checkRoles('admin'));

const id = Joi.object({ id: Joi.number().integer().positive().required() });
const campaignSchema = Joi.object({
  productId:   Joi.number().integer().positive().allow(null),
  name:        Joi.string().trim().min(2).max(120).required(),
  objective:   Joi.string().trim().max(500).allow('', null),
  audience:    Joi.string().trim().max(500).allow('', null),
  concept:     Joi.string().trim().max(1000).allow('', null),
  contentType: Joi.string().trim().max(30).allow('', null),
});
const pieceSchema = Joi.object({
  ref:            Joi.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).required(),
  version:        Joi.number().integer().min(1).default(1),
  videoSha256:    Joi.string().pattern(/^[0-9a-fA-F]{64}$/).required(),
  videoUrl:       Joi.string().uri({ scheme: ['https'] }).max(2000).allow(null),
  telegramFileId: Joi.string().max(300).allow(null),
  width:          Joi.number().integer().positive().required(),
  height:         Joi.number().integer().positive().required(),
  durationS:      Joi.number().positive().max(3600).required(),
  bytes:          Joi.number().integer().positive().allow(null),
});
const postFields = {
  channel:     Joi.string().valid(...CHANNELS),
  scheduledAt: Joi.string().max(40),
  timezone:    Joi.string().max(64),
  caption:     Joi.string().max(63206),
  utmCampaign: Joi.string().pattern(/^[A-Za-z0-9_.-]{1,64}$/), // p. ej. s1_oct26 (calendario del CMO)
};
const postSchema = Joi.object({ ...postFields, network: Joi.string().valid(...NETWORKS).required(), scheduledAt: postFields.scheduledAt.required(), caption: postFields.caption.required() });
const patchSchema = Joi.object(postFields).min(1);
const calendarSchema = Joi.object({ from: Joi.date().iso(), to: Joi.date().iso() });

// Errores de negocio (status) → JSON; el resto al manejador global sin detalles.
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message, ...(err.errors ? { errors: err.errors } : {}) });
    console.error(`[Social] ${req.method} ${req.path} falló: ${err.name}`); // eslint-disable-line no-console
    return next(err);
  }
};

router.get('/campaigns', wrap(async (req, res) => res.json(await svc.listCampaigns())));
router.post('/campaigns', validatorHandler(campaignSchema, 'body'), wrap(async (req, res) => {
  res.status(201).json(await svc.createCampaign(campaignSchema.validate(req.body).value, req.user.sub));
}));
router.post('/campaigns/:id/pieces', validatorHandler(id, 'params'), validatorHandler(pieceSchema, 'body'), wrap(async (req, res) => {
  res.status(201).json(await svc.createPiece(Number(req.params.id), pieceSchema.validate(req.body).value));
}));
router.post('/pieces/:id/posts', validatorHandler(id, 'params'), validatorHandler(postSchema, 'body'), wrap(async (req, res) => {
  res.status(201).json(await svc.addPost(Number(req.params.id), req.body, `user:${req.user.sub}`));
}));
router.patch('/posts/:id', validatorHandler(id, 'params'), validatorHandler(patchSchema, 'body'), wrap(async (req, res) => {
  res.json(await svc.updatePost(Number(req.params.id), req.body, `user:${req.user.sub}`));
}));
router.post('/pieces/:id/review', validatorHandler(id, 'params'), wrap(async (req, res) => {
  res.status(202).json(await svc.sendForReview(Number(req.params.id), `user:${req.user.sub}`));
}));
router.get('/calendar', validatorHandler(calendarSchema, 'query'), wrap(async (req, res) => {
  res.json(await svc.calendar({ from: req.query.from ? new Date(req.query.from) : undefined, to: req.query.to ? new Date(req.query.to) : undefined }));
}));
router.get('/status', wrap(async (req, res) => res.json(await svc.statusPanel())));

module.exports = router;
