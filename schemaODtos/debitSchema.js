const Joi = require('joi');

const id = Joi.number().integer();
const customerId = Joi.number().integer();
const orderId = Joi.number().integer();

const transactionId = Joi.string();
const paymentDate = Joi.date();
const paymentStatus = Joi.string();
const authorizationCode = Joi.string();

const amount = Joi.number()/* .integer() */;

const getDebitSchema = Joi.object({
  id: id.required(),
});

const createDebitSchema = Joi.object({
  customerId: customerId.required(),
  orderId: orderId.required(),
  transactionId: transactionId.required(),
  amount: amount.required(),
  paymentDate: paymentDate,
  paymentStatus: paymentStatus,
  authorizationCode: authorizationCode,
});

/* const updateDebitSchema = Joi.object({
  customerId: customerId,
  state: state
}); */

module.exports = { getDebitSchema, createDebitSchema };