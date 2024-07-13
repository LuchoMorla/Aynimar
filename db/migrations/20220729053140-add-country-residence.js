'use strict';
const { RECYCLER_TABLE, RecyclerSchema } = require('../models/recyclerModel');
const { CUSTOMER_TABLE, CustomerSchema } = require('../models/customerModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(RECYCLER_TABLE, 'residence_country', RecyclerSchema.countryOfResidence);
    await queryInterface.addColumn(CUSTOMER_TABLE, 'residence_country', CustomerSchema.countryOfResidence);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn(RECYCLER_TABLE, "residence_country");
    await queryInterface.removeColumn(CUSTOMER_TABLE, "residence_country");
  }
};
