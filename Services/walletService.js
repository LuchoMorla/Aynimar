const boom = require('@hapi/boom');

const { models } = require('./../libs/sequelize');

class WalletService {
  constructor() {}

  async create(data) {
    const newCredit = await models.Wallet.create({...data});
    return newCredit;
  }

  async find() {
    const rta = await models.Wallet.findAll({
      include: ['recycler']
    });
    return rta;
  }

  async findByUser(userId) {
    console.log(userId);
    const wallet = await models.Wallet.findAll({
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
    for (var i = 0; i < wallet.length; i++) {
      delete wallet[i].dataValues.recycler.dataValues.user.dataValues.password;
    }
    return wallet;
  }

  async findOne(id) {
    const credit = await models.Wallet.findByPk(id, {
      include: ['recycler'] 
    });
    if (!credit) {
      throw boom.notFound('Credit not found');
    }
    return credit;
  }

  async update(id, changes) {
    const recycler = await this.findOne(id);
    const rta = await recycler.update(changes);
    return rta; 
  }

  async delete(id) {
    const recycler = await this.findOne(id);
    await recycler.destroy();
    return { id };
  }
}

module.exports = WalletService;