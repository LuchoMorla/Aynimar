const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const { models } = require('../libs/sequelize');

class CustomerService {

  constructor() {}

  async find() {
    const rta = await models.Customer.findAll({
      include: ['user']
    });
    return rta;
  }

  async findOne(id) {
    const user = await models.Customer.findByPk(id);
    if (!user) {
      throw boom.notFound('customer not found');
    }
    return user;
  }

  async findByUserId(userId) {
    const customer = await models.Customer.findOne({
      where: { 'user_id': userId },
      include: ['user'] 
    });
    return customer;
  }

  async create(data) {
    const hash = await bcrypt.hash(data.user.password, 10);
    const newData = {
      ...data,
      user: {
        ...data.user,
        password: hash
      }
    }
    const newCustomer = await models.Customer.create(newData, {
      include: ['user']
    });
    delete newCustomer.dataValues.user.dataValues.password;
    return newCustomer;
  }

  async createCustomerByRecycler(data) {
    const recyclerCustomer = await models.Customer.create({
      name: data.dataValues.name,
      lastName: data.dataValues.lastName,
      phone: data.dataValues.phone,
      userId: data.dataValues.userId
    });
    return recyclerCustomer;
  }

  async update(id, changes) {
    const model = await this.findOne(id);
    const rta = await model.update(changes);
    return rta;
  }

  async delete(id) {
    const model = await this.findOne(id);
    await model.destroy();
    return { rta: true };
  }

}

module.exports = CustomerService;
