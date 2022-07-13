'use strict';

const { WASTE_TABLE } = require('./../models/wasteModel');
const { WASTE_CATEGORY_TABLE } = require('./../models/wasteCategoryModel');
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn(WASTE_TABLE, 'waste_category_id', {
      field: 'waste_category_id',
      allowNull: false,
      type: DataTypes.INTEGER,
      references: {
        model: WASTE_CATEGORY_TABLE,
        key: 'id',
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropColumn('users');
  },
};
