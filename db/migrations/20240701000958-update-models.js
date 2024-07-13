'use strict';

const { DataTypes } = require("sequelize");
const { BUSINESS_TABLE } = require("../models/businessModel");
const { BUSINESS_OWNER } = require("../models/businessOwnerModel");
const { USER_TABLE } = require("../models/userModel");

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(BUSINESS_TABLE, {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      createdAt: {
        allowNull: false,
        type: DataTypes.DATE,
        field: 'created_at',
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.createTable(BUSINESS_OWNER, {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER,
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING,
      },
      lastName: {
        allowNull: false,
        type: DataTypes.STRING,
        field: 'last_name',
      },
      identityNumber: {
        allowNull: true,
        type: DataTypes.INTEGER,
        field: 'identity_number',
      },
      userId: {
        field: 'user_id',
        allowNull: false,
        type: DataTypes.INTEGER,
        unique: true,
        references: {
          model: USER_TABLE,
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
    });
  },

  // eslint-disable-next-line no-unused-vars
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable(BUSINESS_TABLE);
    await queryInterface.dropTable(BUSINESS_OWNER);
  }
};
