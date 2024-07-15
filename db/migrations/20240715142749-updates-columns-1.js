'use strict';

const { QueryInterface, Sequelize, DataTypes } = require("sequelize");
const { RECYCLER_TABLE, RecyclerSchema } = require("../models/recyclerModel");
const { BUSINESS_OWNER, BussinesOwnerSchema } = require("../models/businessOwnerModel");

module.exports = {
  /**
   * 
   * @param {QueryInterface} queryInterface 
   * @param {Sequelize} Sequelize 
   */
  async up(queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    await queryInterface.changeColumn(RECYCLER_TABLE, RecyclerSchema.identityNumber.field, {
      allowNull: true,
      type: DataTypes.STRING,
    });
    await queryInterface.changeColumn(BUSINESS_OWNER, BussinesOwnerSchema.identityNumber.field, {
      allowNull: true,
      type: DataTypes.STRING,
    });
  },

  /**
  * 
  * @param {QueryInterface} queryInterface 
  * @param {Sequelize} Sequelize 
  */
  async down(queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
  }
};
