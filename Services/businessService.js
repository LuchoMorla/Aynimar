const { Boom } = require('@hapi/boom');
const { models } = require('../libs/sequelize');

class BusinessService {
  async findOne(id) {
    const user = await models.Recycler.findByPk(id);
    if (!user) {
      throw Boom.notFound('Business not found');
    }
    return user;
  }

  async create() {
    const newBusiness = await models.Business.create({}, {
      include: ['user']
    });
    return newBusiness;
  }

}

module.exports = BusinessService;