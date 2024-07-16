const boom = require('@hapi/boom');

const { Op } = require('sequelize');

/* antes era asi const sequelize = require('../libs/sequelize'); 
 const setupModels = require('../db/models'); */
const { models } = require('../libs/sequelize');


class wasteService {

    constructor() {
    }


    async create(data) {
        const newWaste = await models.Waste.create(data);
        return newWaste;
    }

    async find(query) {
        const options = {
            include: ['waste_category'],
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

        const products = await models.Waste.findAll(options);
        return products;
    }

    async findOne(id) {
        /*         const waste = this.wastes.find(commodity => commodity.id === id);
                if (!waste) {
                    throw boom.notFound('waste not found');
                } */
        //vamos a crear un bloqueo para los casos de wasteos bloqueados, seria algo de logica de negocio..sera un error del tipo conflicto
        /*         if (waste.isBlock) {
                    throw boom.conflict('waste is block');
                } */
        const waste = await models.Waste.findByPk(id);
        if (!waste) {
            throw boom.notFound('Waste not found');
        }
        return waste;
    }

    async update(id, changes) {
        /*         const index = this.wastes.findIndex(commodity => commodity.id === id);
                if (index === -1) { */
        /* Comenzaremos a utilizar Boom!! y a manipular los errores de una forma diferente
        throw new Error('product not found'); */
        /*           throw boom.notFound('Product not found');
              }
              const waste = this.wastes[index];
              this.wastes[index] = {
                  ...waste,
                  ...changes
              };
              return this.wastes[index]; */
        const waste = await this.findOne(id);
        const rta = await waste.update(changes);
        return {
            id,
            changes,
            rta
        };
    }

    async delete(id) {
        /*         const index = this.wastes.findIndex(item => item.id === id);
                if (index === -1) {
                    throw boom.notFound('Producto not found');
                }
                this.wastes.splice(index, 1);
                return {message: true, id} */
        const model = await this.findOne(id);
        await model.destroy();
        return { rta: true };
    }
}
module.exports = wasteService;