const Joi = require('joi');

const name = Joi.string();
const email = Joi.string().email();
const message = Joi.string();

const postEmail = Joi.object({
  name: name,
  email: email,
  message: message
});

module.exports = { postEmail };