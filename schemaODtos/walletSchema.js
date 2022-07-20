const Joi = require('joi');

const id = Joi.number().integer();
const recyclerId = Joi.number().integer();
const credit = Joi.number().integer();

const createWalletSchema = Joi.object({
    recyclerId: recyclerId.required(),
    credit: credit
  });
  
  const updateWalletSchema = Joi.object({
    recyclerId: recyclerId,
    credit: credit
  });
  
  const getWalletSchema = Joi.object({
    id: id.required(),
  });

module.exports = { createWalletSchema, updateWalletSchema, getWalletSchema };