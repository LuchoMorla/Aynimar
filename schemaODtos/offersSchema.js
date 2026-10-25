const Joi = require('joi');

const idOffer = Joi.number().integer();
const idPayment = Joi.number().integer();
const status = Joi.string();

const createOfferSchema = Joi.object({
  paymentId: idPayment.required(),
  status,
});

// paymentId no se puede cambiar: reapuntar una oferta a otro pago saltaba el
// control de propiedad (R4/R11). El panel solo envía status.
const updateOfferSchema = Joi.object({
  status,
});

const paramsOfferSchema = Joi.object({
  id: idOffer.required(),
})

module.exports = { createOfferSchema, updateOfferSchema, paramsOfferSchema };