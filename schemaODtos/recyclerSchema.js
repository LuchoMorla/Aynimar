const Joi = require('joi');

const id = Joi.number().integer();
const name = Joi.string();
const lastName = Joi.string();
const identityNumber = Joi.number();
const phone =  Joi.string();
const phoneTwo = Joi.string();
const countryOfResidence = Joi.string();
const province = Joi.string();
const city = Joi.string();
const postalCode = Joi.string();
const streetAddress = Joi.string();
const paymentType = Joi.string();
const bank = Joi.string();
const typeCount = Joi.string();
const countNumber = Joi.string();
const paymentDate = Joi.string();
const stateOfThePayment = Joi.string().empty('');
const userId = Joi.number().integer();
const email = Joi.string().email();
const password =  Joi.string();
const role = Joi.string().empty('');

const getRecyclerSchema = Joi.object({
  id: id.required(),
});

const createRecyclerSchema = Joi.object({
  name: name.required(),
  lastName: lastName.required(),
  identityNumber: identityNumber.required(),
  phone: phone.required(),
  phoneTwo: phoneTwo,
  countryOfResidence: countryOfResidence,
  province: province,
  city: city,
  postalCode: postalCode,
  streetAddress: streetAddress,
  paymentType: paymentType,
  bank: bank,
  typeCount: typeCount,
  countNumber: countNumber,
  paymentDate: paymentDate,
  stateOfThePayment: stateOfThePayment,
  user: Joi.object({
    email: email.required(),
    password: password.required(),
    role: role
  })
});

const updateRecyclerSchema = Joi.object({
  name,
  lastName,
  identityNumber,
  phone,
  phoneTwo,
  countryOfResidence,
  province,
  city,
  postalCode,
  streetAddress,
  paymentType,
  bank,
  typeCount,
  countNumber,
  paymentDate,
  stateOfThePayment,
  userId
});

module.exports = { getRecyclerSchema, createRecyclerSchema, updateRecyclerSchema };