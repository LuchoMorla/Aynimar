'use strict';

const { DataTypes } = require('sequelize');
const { PRODUCT_TABLE } = require('../models/productModel');

module.exports = {
  async up(queryInterface) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    await queryInterface.changeColumn(PRODUCT_TABLE, 'stock', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  },

  async down() {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
  },
};
