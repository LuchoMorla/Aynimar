const Joi = require('joi');

const name = Joi.string();
const email = Joi.string().email();
const celu = Joi.string();
const ubicacionDescrita = Joi.string();
const message = Joi.string();

const postEmail = Joi.object({
  name: name,
  email: email,
  message: message
});

const vendingPostEmail = Joi.object({
  name: name,
  email: email,
  celu: celu,
  ubicacion: ubicacionDescrita,
  message: message
});

module.exports = { postEmail, vendingPostEmail };