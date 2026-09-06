const boom = require('@hapi/boom');

const { Op } = require('sequelize');

/* antes era asi const sequelize = require('../libs/sequelize');
 const setupModels = require('../db/models'); */
const { models } = require('../libs/sequelize');

class ProductsService {
  constructor() {
    /*         this.products = []; */
  }

  async create(data) {
    // Autoridad de precio: si el caller fija `price` explícitamente, este es
    // por definición un camino manual (ProductsService solo se invoca desde
    // routes/productosRouting.js — ningún sync de Dropi/Effi pasa por aquí,
    // ver scripts/smoke-test.js). No se muta `data` del caller.
    const payload = (data && data.price !== undefined && data.price !== null)
      ? { ...data, pricingSource: 'manual' }
      : data;
    const newProduct = await models.Product.create(payload);
    return newProduct;
  }

  async find(query) {

    const options = {
      include: ['category'],
      where: {},
    };
    const { limit, offset } = query;
    if (limit && offset) {
      options.limit = limit;
      options.offset = offset;
    }

    const { price, show_shop } = query;
    if (price) {
      options.where.price = price;
    }
    if (show_shop) {
      options.where.showShop = show_shop === "true";
    }

    const { price_min, price_max } = query;
    if (price_min && price_max) {
      options.where.price = {
        [Op.gte]: price_min,
        [Op.lte]: price_max,
      };
    }

    // --- NUEVO CÓDIGO PARA FILTRAR POR NOMBRE ---
    const { name } = query;
    if (name) {
      options.where.name = {
        [Op.iLike]: `%${name}%` // iLike para búsqueda insensible a mayúsculas/minúsculas (en PostgreSQL)
      };
    }
    // ------------------------------------------

    const products = await models.Product.findAll(options);
    return products;
  }

  async findOne(id) {
    const product = await models.Product.findByPk(id);
    if (!product) {
      throw boom.notFound('Product not found');
    }
    //vamos a crear un bloqueo para los casos de productos bloqueados, seria algo de logica de negocio..sera un error del tipo conflicto
    /*         if (product.isBlock) {
                    throw boom.conflict('Product is block');
                } */
    return product;
  }

  async update(id, changes) {
    /* const index = await this.findOne(id); || this.products.findIndex(item => item.id === id)
        if (index === -1) {*/
    /* Comenzaremos a utilizar Boom!! y a manipular los errores de una forma diferente
        throw new Error('product not found'); */
    /*             throw boom.notFound('Product not found');
                }
                const product = this.products[index];
                this.products[index] = {
                    ...product,
                    ...changes
                };
                return this.products[index]; */
    const product = await this.findOne(id);
    // Igual que en create(): solo una escritura explícita de `price` marca
    // pricingSource='manual'. Una actualización que no toca `price` (stock,
    // showShop, description, ...) deja pricingSource exactamente como estaba
    // — no se reescribe. `changes` (el valor devuelto al caller) no se altera;
    // el campo extra solo viaja en el payload que se persiste.
    const payload = (changes && changes.price !== undefined && changes.price !== null)
      ? { ...changes, pricingSource: 'manual' }
      : changes;
    const rta = await product.update(payload);
    return {
      id,
      changes,
      rta,
    };
  }

  async delete(id) {
    /*  const index = this.products.findIndex(item => item.id === id);
         if (index === -1) {
             throw boom.notFound('Producto not found');
         }
         this.products.splice(index, 1);
         return {message: true, id} */
    const model = await this.findOne(id);
    await model.destroy();
    return { rta: true };
  }
}
module.exports = ProductsService;
