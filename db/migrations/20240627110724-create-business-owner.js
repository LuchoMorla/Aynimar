'use strict';

const { BUSINESS_OWNER, BussinesOwnerSchema } = require('../models/businessOwnerModel');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(BUSINESS_OWNER, BussinesOwnerSchema);
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable(BUSINESS_OWNER);
  }
};