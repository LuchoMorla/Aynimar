'use strict';

const { PRODUCT_TABLE, ProductSchema } = require("../models/productModel");
const { WASTE_TABLE, WasteSchema } = require("../models/wasteModel");

module.exports = {
  async up(queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    await queryInterface.addColumn(PRODUCT_TABLE, ProductSchema.businessId.field, ProductSchema.businessId);
    await queryInterface.addColumn(WASTE_TABLE, ProductSchema.businessId.field, WasteSchema.businessId);

  },

  async down(queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
    */
    await queryInterface.removeColumn(PRODUCT_TABLE, ProductSchema.businessId.field);
    await queryInterface.removeColumn(WASTE_TABLE, ProductSchema.businessId.field);
  }
};
