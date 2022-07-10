const Joi = require('joi');

const id = Joi.number().integer();
const name = Joi.string().min(3).max(30);
const lastName = Joi.string();
const identityNumber = Joi.number();
const phone =  Joi.string();
const paymentType = Joi.string();
const bank = Joi.string();
const typeCount = Joi.string();
const countNumber = Joi.string();
const paymentCity = Joi.string();
const paymentDate = Joi.string();
const stateOfThePayment = Joi.string().empty('').default('revision');
const userId = Joi.number().integer();
const email = Joi.string().email();
const password =  Joi.string();
const role = Joi.string().empty('').default('recycler');

const getRecyclerSchema = Joi.object({
  id: id.required(),
});

const createRecyclerSchema = Joi.object({
  name: name.required(),
  lastName: lastName.required(),
  phone: phone.required(),
  identityNumber: identityNumber.required(),
  user: Joi.object({
    email: email.required(),
    password: password.required(),
    role: role
  }),
  paymentType: paymentType,
  bank: bank,
  typeCount: typeCount,
  countNumber: countNumber,
  paymentCity: paymentCity,
  paymentDate: paymentDate,
  stateOfThePayment: stateOfThePayment,
});

const updateRecyclerSchema = Joi.object({
  name,
  lastName,
  phone,
  identityNumber,
  userId,
  paymentType,
  bank,
  typeCount,
  countNumber,
  paymentCity,
  paymentDate,
  stateOfThePayment
});

module.exports = { getRecyclerSchema, createRecyclerSchema, updateRecyclerSchema };