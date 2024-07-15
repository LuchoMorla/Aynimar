'use strict';

const { QueryInterface, Sequelize } = require("sequelize");
const { WASTE_TABLE, WasteSchema } = require("../models/wasteModel");
const { PRODUCT_TABLE, ProductSchema } = require("../models/productModel");

module.exports = {
  /**
  * 
  * @param {QueryInterface} queryInterface 
  * @param {Sequelize} Sequelize 
  */
  async up(queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    await queryInterface.changeColumn(WASTE_TABLE, "price", WasteSchema.price);
    await queryInterface.changeColumn(PRODUCT_TABLE, "price", ProductSchema.price);
  },
  /**
   * 
   * @param {QueryInterface} queryInterface 
   * @param {Sequelize} Sequelize 
   */
  async down(queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */

  }
};
