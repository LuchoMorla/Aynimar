'use strict';

const { DataTypes } = require('sequelize');
const { ORDER_PRODUCT_TABLE } = require('../models/order-productModel');

module.exports = {
  async up(queryInterface) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    queryInterface.changeColumn(ORDER_PRODUCT_TABLE, 'order_id', {
      type: DataTypes.INTEGER,

      allowNull: true,
    });
    queryInterface.changeColumn(ORDER_PRODUCT_TABLE, 'product_id', {
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
