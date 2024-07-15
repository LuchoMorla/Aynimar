const Joi = require('joi');

const idOffer = Joi.number().integer();
const idPayment = Joi.number().integer();
const status = Joi.string();

const createOfferSchema = Joi.object({
  paymentId: idPayment.required(),
  status,
});

const updateOfferSchema = Joi.object({
  paymentId: idPayment,
  status,
});

const paramsOfferSchema = Joi.object({
  id: idOffer.required(),
})

module.exports = { createOfferSchema, updateOfferSchema, paramsOfferSchema };