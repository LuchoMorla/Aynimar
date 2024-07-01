'use strict';

const { BUSINESS_TABLE, BusinessSchema } = require("../models/businessModel");

module.exports = {
  async up(queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    await queryInterface.addColumn(BUSINESS_TABLE, BusinessSchema.owner.field, BusinessSchema.owner);

  },

  async down(queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
    */
    await queryInterface.removeColumn(BUSINESS_TABLE, BusinessSchema.owner.field);
  }
};
