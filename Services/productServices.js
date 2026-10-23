const boom = require('@hapi/boom');

const { Op } = require('sequelize');

/* antes era asi const sequelize = require('../libs/sequelize');
 const setupModels = require('../db/models'); */
const { models } = require('../libs/sequelize');

// Campos que la tienda pública (sin auth de admin) puede ver. Es una ALLOWLIST:
// cualquier columna nueva del modelo queda privada por defecto. Fuera quedan,
// entre otros: costPrice, pricingSource/pricingCostSnapshot/pricingCalculatedPrice/
// pricingAppliedAt, dropiProductId, sourceProvider, lastSyncAt e isDeleted.
// Campos verificados contra lo que consume frontAynimar (store/[id], FormProduct,
// ProductList, sitemap).
const PUBLIC_PRODUCT_FIELDS = [
  'id', 'name', 'image', 'images', 'description', 'price', 'stock', 'showShop',
  'createdAt', 'categoryId', 'businessId', 'externalId', 'variants', 'attributes',
  'isBundle', 'dropiItems',
];

// Proyección a la forma pública. Se aplica sobre el objeto ya leído (no solo vía
// `attributes` en SQL) para que un campo interno nunca salga aunque cambie la query.
// dropiItems: la tienda necesita {id, value, qty, price} para el selector de variantes
// (precio por presentación) y el resumen de pack; dropiId (proveedor) NO sale.
function toPublicProduct(product) {
  const row = product && typeof product.toJSON === 'function' ? product.toJSON() : product;
  const out = {};
  for (const field of PUBLIC_PRODUCT_FIELDS) {
    if (field in row) out[field] = row[field];
  }
  if (Array.isArray(out.dropiItems)) {
    out.dropiItems = out.dropiItems.map((item) => ({
      id: item?.id, value: item?.value, qty: item?.qty, price: item?.price,
    }));
  }
  if (row.category) {
    const { id, name, image } = row.category;
    out.category = { id, name, image };
  }
  return out;
}

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

  // publicView=true: solo productos visibles en tienda (no borrados, showShop) y
  // solo campos públicos. publicView=false: modelo completo (uso admin).
  async find(query, { publicView = false } = {}) {

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

    if (publicView) {
      options.attributes = PUBLIC_PRODUCT_FIELDS;
      // Se aplican después de los filtros del query: un `show_shop=false`
      // público no puede sobreescribirlos.
      options.where.isDeleted = false;
      options.where.showShop = true;
    }

    const products = await models.Product.findAll(options);
    return publicView ? products.map(toPublicProduct) : products;
  }

  // Lectura pública de un producto: borrados y borradores (showShop=false) no
  // existen para la tienda → 404. update()/delete() siguen usando findOne().
  async findOnePublic(id) {
    const product = await models.Product.findByPk(id, {
      attributes: [...PUBLIC_PRODUCT_FIELDS, 'isDeleted'],
    });
    if (!product || product.isDeleted || product.showShop !== true) {
      throw boom.notFound('Product not found');
    }
    return toPublicProduct(product);
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
module.exports.PUBLIC_PRODUCT_FIELDS = PUBLIC_PRODUCT_FIELDS;
