const Joi = require('joi');

/*  ya no lo necesitamos, ahora que nos vamos a conectar a la base de datos y tenemos id id con la regla de autoincremental... ya podemos ignorar el uuid y utilizarlo como un
integer
const id = Joi.string().uuid(); */
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

// Dropshipping sync fields — all optional, set by importService
const externalId     = Joi.string().allow(null);
const sourceProvider = Joi.string().valid('dropi', 'effi').allow(null);
const lastSyncAt     = Joi.date().allow(null);
const images         = Joi.string().allow(null); // JSON-stringified array

//recibiremos un limit y un offset
const limit = Joi.number().integer();
const offset = Joi.number().integer();

// filtrando por rango de precios
const price_min = Joi.number().integer();
const price_max = Joi.number().integer();

const createProductSchema = Joi.object({
  name: name.required(),
  price: price.required(),
  description: description.required(),
  image: image.required(),
  categoryId: categoryId.required(),
  businessId: businnesId,
  isDeleted: isDeleted,
  stock: stock,
  showShop: showShop,
});

const updateProductSchema = Joi.object({
  name:           name,
  price:          price,
  image:          image,
  description:    Joi.string().min(1).allow('', null), // relaxed for manual edits
  categoryId:     categoryId,
  businessId:     Joi.number().integer().allow(null),  // null = desvincular de negocio
  isDeleted:      isDeleted,
  stock:          stock,
  showShop:       showShop,
  externalId,
  sourceProvider,
  lastSyncAt,
  images,
});

const getProductSchema = Joi.object({
  id: id.required(),
});

const queryProductSchema = Joi.object({
  limit,
  offset,
  price,
  price_min,
  price_max: price_max.when('price_min', {
    is: Joi.number().integer(),
    then: Joi.required(),
  }),
  show_shop: showShop,
  name: Joi.string()
});

module.exports = {
  createProductSchema,
  updateProductSchema,
  getProductSchema,
  queryProductSchema,
};
