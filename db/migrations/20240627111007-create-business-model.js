'use strict';

const { BUSINESS_TABLE, BusinessSchema } = require('../models/businessModel');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(BUSINESS_TABLE, BusinessSchema);
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable(BUSINESS_TABLE);
  }
};