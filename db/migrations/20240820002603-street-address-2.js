'use strict';
const { CUSTOMER_TABLE, CustomerSchema } = require('../models/customerModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(CUSTOMER_TABLE, CustomerSchema);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable(CUSTOMER_TABLE);
  }
};