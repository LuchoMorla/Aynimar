const boom = require('@hapi/boom');

const { models } = require('../libs/sequelize');

class WasteCategoryService {

  constructor(){
  }
  async create(data) {
    const newWasteCategory = await models.WasteCategory.create(data);
    return newWasteCategory;
  }

  async find() {
    const wasteCategories = await models.WasteCategory.findAll();
    return wasteCategories;
  }

  async findOne(id) {
    const wasteCategory = await models.WasteCategory.findByPk(id, {
      include: ['wastes']
    });
    return wasteCategory;
  }

  async update(id, changes) {
    const wasteCategory = await this.findOne(id);
    const rta = await wasteCategory.update(changes);
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

module.exports = WasteCategoryService;