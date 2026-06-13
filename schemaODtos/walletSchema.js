'use strict';

const Joi = require('joi');

const id         = Joi.number().integer();
const userId     = Joi.number().integer();
const recyclerId = Joi.number().integer().allow(null);
const credit     = Joi.number().integer().min(0);
const amount     = Joi.number().integer().min(1);

const createWalletSchema = Joi.object({
  userId:     userId.required(),
  recyclerId: recyclerId,
  credit:     credit.default(0),
});

const updateWalletSchema = Joi.object({
  credit: credit,
});

const getWalletSchema = Joi.object({
  id: id.required(),
});

// Used by POST /wallets/add-credits and POST /wallets/redeem
const creditOperationSchema = Joi.object({
  userId: userId.required(),
  amount: amount.required(),
});

module.exports = {
  createWalletSchema,
  updateWalletSchema,
  getWalletSchema,
  creditOperationSchema,
};
