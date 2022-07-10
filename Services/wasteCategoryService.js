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
    return {
      id,
      changes,
    };
  }

  async delete(id) {
    return { id };
  }

}

module.exports = WasteCategoryService;