'use strict';

const { PRODUCT_TABLE } = require('../models/productModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(PRODUCT_TABLE, 'dropi_product_id', {
      type:         Sequelize.STRING,
      allowNull:    true,
      defaultValue: null,
      comment:      'Dropi product ID for internal organization',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(PRODUCT_TABLE, 'dropi_product_id');
  },
};
