const Joi = require('joi');

const id = Joi.number().integer();
const name = Joi.string().min(3).max(15);
const image = Joi.string().uri();

const createWasteCategorySchema = Joi.object({
  name: name.required(),
  image: image.required()
});

const updateWasteCategorySchema = Joi.object({
  name: name,
  image: image
});

const getWasteCategorySchema = Joi.object({
  id: id.required(),
});

module.exports = { createWasteCategorySchema, updateWasteCategorySchema, getWasteCategorySchema }