'use strict';

const { PRODUCT_TABLE } = require('../models/productModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(PRODUCT_TABLE, 'variants', {
      type:         Sequelize.TEXT,
      allowNull:    true,
      defaultValue: null,
      comment:      'JSON array de variantes: [{option, values:[{label,image,stock}]}]',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(PRODUCT_TABLE, 'variants');
  },
};
