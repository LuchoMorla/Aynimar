const Joi = require('joi');
const regularExpresion = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]*$/;

const email = Joi.string().email(),
  password = Joi.string()/* .min() */, //tenia una validacion de 8 carateres y le quite
  newPassword = Joi.string()/* .min() */,
  token = Joi.string().regex(regularExpresion);

const loginAuthSchema = Joi.object({
  email: email.required(),
  password: password.required(),
});

const recoveryAuthSchema = Joi.object({
  email: email.required(),
});

const changePasswordAuthSchema = Joi.object({
  token: token.required(),
  newPassword: newPassword.required(),
});

const autoLoginAuthSchema = Joi.object({
  token: token.required()
});

module.exports = {
  loginAuthSchema,
  recoveryAuthSchema,
  changePasswordAuthSchema,
  autoLoginAuthSchema
};