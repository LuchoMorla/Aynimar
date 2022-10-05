'use strict';
const { ORDER_TABLE, OrderSchema } = require('../models/orderModel');

module.exports = {
  async up (queryInterface, Sequelize) {
   await queryInterface.addColumn(ORDER_TABLE, 'state', OrderSchema.state);
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn(ORDER_TABLE, 'state');
  }
}; 
