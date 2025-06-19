const Joi = require('joi');

const id = Joi.number().integer();
const name = Joi.string().min(3).max(50);
const price = Joi.number().min(0);
const description = Joi.string().min(10);
const image = Joi.string().uri();
const categoryId = Joi.number().integer();
const businnesId = Joi.number().integer();
const isDeleted = Joi.boolean();
const stock = Joi.number().integer().allow(null);
const showShop = Joi.boolean();

const limit = Joi.number().integer();
const offset = Joi.number().integer();
const price_min = Joi.number().integer();
const price_max = Joi.number().integer();

const createProductSchema = Joi.object({
  name: name.required(),
  price: price.required(),
  description: description.required(),
  image: image.required(),
  categoryId: categoryId.required(),
  businessId: businnesId,
  isDeleted,
  stock,
  showShop,
});

const updateProductSchema = Joi.object({
  name,
  price,
  image,
  description,
  categoryId,
  businessId: businnesId,
  isDeleted,
  stock,
  showShop,
});

const getProductSchema = Joi.object({
  id: id.required(),
});

const queryProductSchema = Joi.object({
  limit,
  offset,
  price,
  price_min,
  price_max,
  show_shop: showShop,
}).custom((value, helpers) => {
  const { price_min, price_max } = value;

  if ((price_min !== undefined && price_max === undefined) ||
      (price_max !== undefined && price_min === undefined)) {
    return helpers.message('Si usas price_min o price_max, debes enviar ambos');
  }

  if (price_min !== undefined && price_max !== undefined && price_min > price_max) {
    return helpers.message('price_min no puede ser mayor que price_max');
  }

  return value;
});

module.exports = {
  createProductSchema,
  updateProductSchema,
  getProductSchema,
  queryProductSchema
};

