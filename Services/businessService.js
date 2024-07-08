const Boom = require('@hapi/boom');
const { models } = require('../libs/sequelize');

class BusinessService {
  async findOne(id) {
    const business = await models.Business.findByPk(id, {
      include: ["products", "wastes"]
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

}

module.exports = BusinessService;