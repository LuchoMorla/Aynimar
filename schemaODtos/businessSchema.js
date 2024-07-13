const Joi = require('joi');

const id = Joi.number().integer();
const name = Joi.string();
const image = Joi.string();
const description = Joi.string().min(8);
const ownerId = Joi.number().integer();

const getBusinessSchema = Joi.object({
  id: id.required(),
});

const createBusinessSchema = Joi.object({
  name: name.required(),
  image: image.required(),
  description: description.required(),
  ownerId: ownerId.required()
});

const updateBusinessSchema = Joi.object({
  name,
  image,
  description,
});

module.exports = { getBusinessSchema, createBusinessSchema, updateBusinessSchema };