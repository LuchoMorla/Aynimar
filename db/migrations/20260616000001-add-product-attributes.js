'use strict';

const { PRODUCT_TABLE } = require('../models/productModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(PRODUCT_TABLE, 'attributes', {
      type:         Sequelize.JSONB,
      allowNull:    true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(PRODUCT_TABLE, 'attributes');
  },
};
