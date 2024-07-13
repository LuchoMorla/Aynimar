const Joi = require('joi');

const id = Joi.number().integer();
const name = Joi.string();
const lastName = Joi.string();
const identityNumber = Joi.number();
const userId = Joi.number().integer();
const email = Joi.string().email();
const password = Joi.string();
const role = Joi.string().empty('');

const getBusinessOwnerSchema = Joi.object({
  id: id.required(),
});

const createBusinessOwnerSchema = Joi.object({
  name: name.required(),
  lastName: lastName.required(),
  identityNumber: identityNumber.required(),
  user: Joi.object({
    email: email.required(),
    password: password.required(),
    role: role
  })
});

const updateBusinessOwnerSchema = Joi.object({
  name,
  lastName,
  identityNumber,
  userId
});

module.exports = { getBusinessOwnerSchema, createBusinessOwnerSchema, updateBusinessOwnerSchema };