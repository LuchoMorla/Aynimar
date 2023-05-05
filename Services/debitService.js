const boom = require('@hapi/boom');
const { models } = require('../libs/sequelize');

class DebitService {

  constructor(){
  }

  async create(data) {
    console.log('we are at debit Service');    
/*    const customerIdBody = data.customerId;
     if (customerIdBody == idT) { */
      const newDebit = await models.Debit.create(data);
      return newDebit;
    /* } else {
      throw boom.badRequest('you are not a customer, somenthing went wrong here!!!');
    } */
  }

  async findByUser(userId) {
/*     const orders = await models.Order.findAll({
      where: {
        '$customer.user.id$': userId
      },
      include: [
        {
          association: 'customer',
          include: ['user']
        },
        'items'
      ]
    });

    for (var i = 0; i < orders.length; i++) {
      delete orders[i].dataValues.customer.dataValues.user.dataValues.password;
    }
    
    return orders; */
  }

  async find() {
    const debits = await models.Debit.findAll();

    return debits;
  }

  async findOne(id) {
    const userDebit = await models.Debit.findByPk(id);
    return userDebit;
  }

}

module.exports = DebitService;