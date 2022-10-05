const Joi = require('joi');

const id = Joi.number().integer();
const customerId = Joi.number().integer();
const orderId = Joi.number().integer();
const productId = Joi.number().integer();
const amount = Joi.number().integer().min(1);

const getOrderSchema = Joi.object({
  id: id.required(),
});

const createOrderSchema = Joi.object({
  customerId: customerId.required(),
});
 //ITEMS
const addItemSchema = Joi.object({
  orderId: orderId.required(),
  productId: productId.required(),
  amount: amount.required(),
});

const getItemSchema = Joi.object({
  id: id.required(),
});

const updateItemSchema = Joi.object({
  orderId: orderId,
  productId: productId,
  amount: amount,
});
//se le podrían agregar cosas como estados(entregada, se pago, no se pago, etc.), dirección, etc.

module.exports = { getOrderSchema, createOrderSchema, addItemSchema, updateItemSchema, getItemSchema };