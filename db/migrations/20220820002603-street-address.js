'use strict';
const { RECYCLER_TABLE, RecyclerSchema } = require('../models/recyclerModel');
const { CUSTOMER_TABLE, CustomerSchema } = require('../models/customerModel');

module.exports = {
  async up (queryInterface, Sequelize) {
   await queryInterface.addColumn(RECYCLER_TABLE, 'street_address', RecyclerSchema.streetAddress);
   await queryInterface.addColumn(CUSTOMER_TABLE, 'street_address', CustomerSchema.streetAddress);
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn(RECYCLER_TABLE, 'street_address');
    await queryInterface.removeColumn(CUSTOMER_TABLE, 'street_address');
  }
};
