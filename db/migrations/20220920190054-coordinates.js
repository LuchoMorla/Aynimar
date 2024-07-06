'use strict';
const { RECYCLER_TABLE, RecyclerSchema } = require('../models/recyclerModel');
const { CUSTOMER_TABLE, CustomerSchema } = require('../models/customerModel');

module.exports = {
  async up (queryInterface, Sequelize) {
   await queryInterface.addColumn(RECYCLER_TABLE, 'geolocation', RecyclerSchema.geolocation);
   await queryInterface.addColumn(CUSTOMER_TABLE, 'geolocation', CustomerSchema.geolocation);
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn(RECYCLER_TABLE, 'geolocation');
    await queryInterface.removeColumn(CUSTOMER_TABLE, 'geolocation');
  }
}; 