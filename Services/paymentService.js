const boom = require('@hapi/boom');

const { models } = require('../libs/sequelize');

class PaymentService {

  constructor(){
  }

  async create(data) {
    const recycler = await models.Recycler.findOne({
      where: {
        '$user.id$': data.userId
      },
      include: ['user']
    })
    if (!recycler) {
      throw boom.badRequest('Recycler not found');
    }
    const newPayment = await models.Payment.create({ recyclerId: recycler.id });
    return newPayment;
  }

  async addCommodity(data) {
    const newcommoditie = await models.PaymentWaste.create(data);
    return newcommoditie;
  }

  async findByUser(userId) {
    const payments = await models.Payment.findAll({
      where: {
        '$recycler.user.id$': userId
      },
      include: [
        {
          association: 'recycler',
          include: ['user']
        }
      ]
    });
    for (let i = 0; i < payments.length; i++) {
      delete payments[i].dataValues.recycler.dataValues.user.dataValues.password;
    }
    return payments;
  }

  async find() {
    const payments = await models.Payment.findAll({
      include: [
        {
          association: 'recycler',
          include: ['user']
        },
        'commodities'
      ]
    });

    for (let i = 0; i < payments.length; i++) {
      delete payments[i].dataValues.recycler.dataValues.user.dataValues.password;
    }

    return payments;
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
    delete payment.dataValues.recycler.dataValues.user.dataValues.password;
    return payment;
  }

  async update(id, changes) {
    const payment = await this.findOne(id);
    const rta = await payment.update(changes);
    return {
      id,
      changes,
      rta
    };
  }

  async delete(id) {
    const model = await this.findOne(id);
    await model.destroy();
    return { rta: true };
  }

}

module.exports = PaymentService;