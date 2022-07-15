const Joi = require('joi');

const id = Joi.number().integer();
const recyclerId = Joi.number().integer();
const paymentId = Joi.number().integer();
const wasteId = Joi.number().integer();
const amount = Joi.number().integer();

const getPaymentSchema = Joi.object({
  id: id.required(),
});

const createPaymentSchema = Joi.object({
  recyclerId: recyclerId,
});

const addCommoditySchema = Joi.object({
  paymentId: paymentId.required(),
  wasteId: wasteId.required(),
  amount: amount.required(),
});

//se le podrían agregar cosas como estados(entregada, se pago, no se pago, etc.), dirección, etc.

module.exports = { getPaymentSchema, createPaymentSchema, addCommoditySchema };
