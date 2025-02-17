'use strict';

const { ORDER_TABLE, OrderSchema } = require('../models/orderModel');
const { PRODUCT_TABLE, ProductSchema } = require('../models/productModel');

module.exports = {
  async up(queryInterface) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id.INTEGER });
     */
    await queryInterface.addColumn(
      ORDER_TABLE,
      'state_order',
      OrderSchema.stateOrder
    );

    await queryInterface.addColumn(PRODUCT_TABLE, 'stock', ProductSchema.stock);
    await queryInterface.addColumn(
      PRODUCT_TABLE,
      'show_shop',
      ProductSchema.showShop
    );
  },

  async down(queryInterface) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */

    await queryInterface.removeColumn(ORDER_TABLE, 'state_order');

    await queryInterface.removeColumn(PRODUCT_TABLE, 'stock');

    await queryInterface.removeColumn(PRODUCT_TABLE, 'show_shop');
  },
};
