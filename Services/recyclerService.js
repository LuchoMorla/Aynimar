const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const { models } = require('../libs/sequelize');

class RecyclerService {

  constructor() {}

  async find() {
    const rta = await models.Recycler.findAll({
      include: ['user']
    });
    return rta;
  }

  async findOne(id) {
    const user = await models.Recycler.findByPk(id);
    if (!user) {
      throw boom.notFound('Recycler not found');
    }
    return user;
  }

  async create(data) {
    const hash = await bcrypt.hash(data.user.password, 10);
    const role = 'recycler';
    const newData = {
      ...data,
      user: {
        ...data.user,
        password: hash,
        role: role
      }
    }
    const newRecycler = await models.Recycler.create(newData, {
      include: ['user']
    });
    delete newRecycler.dataValues.user.dataValues.password;
    return newRecycler;
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

module.exports = RecyclerService;