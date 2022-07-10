const Joi = require('joi');

const id = Joi.number().integer();
const customerId = Joi.number().integer();
const orderId = Joi.number().integer();
const productId = Joi.number().integer();
const amount = Joi.number().integer();

const getPaymentSchema = Joi.object({
  id: id.required(),
});

const createPaymentSchema = Joi.object({
  customerId: customerId.required(),
});

const addCommoditieSchema = Joi.object({
  orderId: orderId.required(),
  productId: productId.required(),
  amount: amount.required(),
});

//se le podrían agregar cosas como estados(entregada, se pago, no se pago, etc.), dirección, etc.

module.exports = { getPaymentSchema, createPaymentSchema, addCommoditieSchema };
