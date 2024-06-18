/* eslint-disable no-console */
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
        try {
            const category = await models.Category.findByPk(data.categoryId);
            if (!category) {
                console.error('Invalid category ID');
            }
            const newProduct = await models.Product.create(data);
            return newProduct;
        } catch (err) {
            if (err.name === 'SequelizeForeignKeyConstraintError') {
                console.error('Invalid category ID');
            }
            console.error('Internal server error');
        }
    }

    async findAll() {
        const options = {
            include: ['category'],
            where: {}
        }

        const products = await models.Product.findAll(options);
        return products;
    }

    async find(query) {

        const options = {
            include: ['category'],
            where: {}
        }
        const { limit, offset } = query;
        if (limit && offset) {
            options.limit = limit;
            options.offset = offset;
        }

        const { price } = query;
        if (price) {
            options.where.price = price;
        }

        const { price_min, price_max } = query;
        if (price_min && price_max) {
            options.where.price = {
                [Op.gte]: price_min,
                [Op.lte]: price_max,
            };
        }

        const products = await models.Product.findAll(options);
        products.forEach((o) => o.price = o.price / 100);
        return products;
    }

    async findOne(id) {
        const product = await models.Product.findByPk(id);
        product.price = product.price / 100;
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
        const rta = await product.update(changes);
        return {
          id,
          changes,
          rta
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