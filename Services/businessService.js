const Boom = require('@hapi/boom');
const { models } = require('../libs/sequelize');

class BusinessService {
  async findOne(id) {
    const business = await models.Business.findByPk(id, {
      include: ['products', 'wastes'],
    });
    if (!business) {
      throw Boom.notFound('Business not found');
    }
    return business;
  }

  async create(data) {
    const newBusiness = await models.Business.create(data);
    return newBusiness;
  }

  async find() {
    const business = await models.Business.findAll();
    return business;
  }

  async update(id, changes) {
    const business = await this.findOne(id);
    const updatedBusiness = await business.update(changes);
    return updatedBusiness;
  }

  async delete(id) {
    const business = await this.findOne(id);
    await business.destroy();
    return { rta: true };
  }
}

module.exports = BusinessService;
