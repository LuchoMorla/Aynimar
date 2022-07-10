const boom = require('@hapi/boom');

const { models } = require('../libs/sequelize');

class PaymentService {

  constructor(){
  }

  async create(data) {
    const newPayment = await models.Payment.create(data);
    return newPayment;
  }

  async addItem(data) {
    const newcommoditie = await models.PaymentWaste.create(data);
    return newcommoditie;
  }

  async findByUser(userId) {
    const payments = await models.Payment.findAll({
      where: {
        '$customer.user.id$': userId
      },
      include: [
        {
          association: 'recycler',
          include: ['user']
        }
      ]
    });
    return payments;
  }

  async find() {
    return [];
  }

  async findOne(id) {
    const payment = await models.Payment.findByPk(id, {
      include: [
        {
          association: 'recycler',
          include: ['user']
        },
        'commodities'
      ]
    });
    return payment;
  }

  async update(id, changes) {
    return {
      id,
      changes,
    };
  }

  async delete(id) {
    return { id };
  }

}

module.exports = PaymentService;