const Joi = require('joi');

const id = Joi.number().integer();
const customerId = Joi.number().integer();
const orderId = Joi.number().integer();
const productId = Joi.number().integer();
const amount = Joi.number().integer().min(1);
const state = Joi.string();

const getOrderSchema = Joi.object({
  id: id.required(),
});

const getOrderByState = Joi.object({
  state: state.required(),
});
/* me parece que es su id es el orderID que hay que enviarle */
const getOrderByUserIdAndOrderId = Joi.object({
  id: id.required(),
});
/* No estoy tran seguro de decar el create order sin el required */
const createOrderSchema = Joi.object({
  customerId: customerId,
});

const updateOrderSchema = Joi.object({
  customerId: customerId,
  state: state
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

const getOrdersByBusinessId = Joi.object({
  businessId: id.required(),
});

const updateItemSchema = Joi.object({
  orderId: orderId,
  productId: productId,
  amount: amount,
});
//se le podrían agregar cosas como estados(entregada, se pago, no se pago, etc.), dirección, etc.

module.exports = { getOrderSchema, getOrderByUserIdAndOrderId, getOrderByState, createOrderSchema, updateOrderSchema, addItemSchema, updateItemSchema, getItemSchema, getOrdersByBusinessId };