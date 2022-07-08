const faker = require('faker');
const boom = require('@hapi/boom');

const { Op } = require('sequelize');

/* antes era asi const sequelize = require('../libs/sequelize'); 
 const setupModels = require('../db/models'); */
const { models } = require('../libs/sequelize');


class ProductsService {

    constructor() {
        this.products = [];
        //Vamos a decir que cada vez que corra una instancia del servicio, va a empezar y generar los productos:
        this.generate();
        /*  ya no utilizamos consultas por medio del pool
        this.pool = pool;
        this.pool.on('error', (err) => console.error(err)); */
    }
    // será el metodo para generar con la datafake
    generate() {
        const limit = 100; //size || 10;
        for (let index = 0; index < limit; index++) {
            this.products.push({
                id: faker.datatype.uuid(),
                name: faker.commerce.productName(),
                price: parseInt(faker.commerce.price(), 10),
                image: faker.image.imageUrl(),
                //Nos crearemos el supuesto de que tuvieramos que utilizar un bloqueo de permiso para productos que se pueden o no presentar a un determinado cliente
                isBlock: faker.datatype.boolean(),
            });
        }
    }

    async create(data) {
/*       Antes de hacer el llamado a la base de datos
      const newProduct = {
            id: faker.datatype.uuid(),
            ...data
        }
        this.products.push(newProduct);
        return newProduct; */
        const newProduct = await models.Product.create(data);
        return newProduct;
    }

    async find(query) {
/*         return new Promise((resolve) => {
            setTimeout(() => {
                resolve(this.products);
            }, 1000); 
        }); */
        // Antes solo era un simple return this.products... :') como ah crecido la promesa!!!
/*               Se utilizaba antes para hacer consultas desde la base de datos
  const query = 'SELECT * FROM task'; */
/*         const rta = await this.pool.query(query);
        return rta.rows; */
/*        Se utilizaba antes para hacer consultas desde la base de datos
 const [ data ] = await sequelize.query(query);
        return data; */
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
        return products;
    }

    async findOne(id) {
        const product = this.products.find(item => item.id === id);
        if (!product) {
            throw boom.notFound('Product not found');
        }
        //vamos a crear un bloqueo para los casos de productos bloqueados, seria algo de logica de negocio..sera un error del tipo conflicto
        if (product.isBlock) {
            throw boom.conflict('Product is block');
        }
        return product;
    }

    async update(id, changes) {
        const index = this.products.findIndex(item => item.id === id);
        if (index === -1) {
            /* Comenzaremos a utilizar Boom!! y a manipular los errores de una forma diferente
            throw new Error('product not found'); */
            throw boom.notFound('Product not found');
        }
        const product = this.products[index];
        this.products[index] = {
            ...product,
            ...changes
        };
        return this.products[index];
    }

    async delete(id) {
        const index = this.products.findIndex(item => item.id === id);
        if (index === -1) {
            throw boom.notFound('Producto not found');
        }
        this.products.splice(index, 1);
        return {message: true, id}
    }
}
module.exports = ProductsService;