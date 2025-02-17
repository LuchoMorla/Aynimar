'use strict';

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
      PRODUCT_TABLE,
      ProductSchema.isDeleted.field,
      ProductSchema.isDeleted
    );
  },

  async down(queryInterface) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
    await queryInterface.removeColumn(
      PRODUCT_TABLE,
      ProductSchema.isDeleted.field
    );
  },
};
