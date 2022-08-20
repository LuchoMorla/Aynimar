const Joi = require('joi');

const id = Joi.number().integer();
const name = Joi.string();
const lastName = Joi.string();
const identityNumber = Joi.string();
const phone =  Joi.string();
const phoneTwo = Joi.string();
const countryOfResidence = Joi.string();
const province = Joi.string();
const city = Joi.string();
const postalCode = Joi.string();
const streetAddress = Joi.string();
const userId = Joi.number().integer();
const email = Joi.string().email();
const password =  Joi.string();
const getCustomerSchema = Joi.object({
  id: id.required(),
});

const createCustomerSchema = Joi.object({
  name: name.required(),
  lastName: lastName.required(),
  identityNumber: identityNumber,
  phone: phone,
  phoneTwo: phoneTwo,
  countryOfResidence: countryOfResidence,
  province: province,
  city: city,
  postalCode: postalCode,
  streetAddress: streetAddress,
  user: Joi.object({
    email: email.required(),
    password: password.required()
  })
});

const updateCustomerSchema = Joi.object({
  name,
  lastName,
  phone,
  phoneTwo,
  province,
  city,
  countryOfResidence,
  postalCode,
  streetAddress,
  userId
});

module.exports = { getCustomerSchema, createCustomerSchema, updateCustomerSchema };