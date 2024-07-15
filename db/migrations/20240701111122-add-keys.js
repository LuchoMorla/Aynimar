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
    await queryInterface.changeColumn(BUSINESS_TABLE, BusinessSchema.ownerId.field, BusinessSchema.ownerId);
  },

  async down(queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
    */
  }
};
