'use strict';

const { PRODUCT_TABLE } = require('../models/productModel');

// dropiItems enables "bundle" products: one Aynimar product dispatches multiple Dropi
// product IDs in a single order. Shape: [{ id: "12345", qty: 1 }, { id: "67890", qty: 2 }]
// When present, takes priority over dropiProductId in dispatchToProviders.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(PRODUCT_TABLE, 'dropi_items', {
      type:         Sequelize.JSONB,
      allowNull:    true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(PRODUCT_TABLE, 'dropi_items');
  },
};
