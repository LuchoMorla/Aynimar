'use strict';

const { WALLET_TABLE } = require('./../models/walletModel');
const { RECYCLER_TABLE } = require('./../models/recyclerModel');
const { DataTypes, Sequelize } = require('sequelize');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(WALLET_TABLE, {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER,
      },
      recyclerId: {
        field: 'recycler_id',
        allowNull: false,
        type: DataTypes.INTEGER,
        unique: true,
        references: {
          model: RECYCLER_TABLE,
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      credit: {
        allowNull: true,
        type: DataTypes.INTEGER,
      },
      createdAt: {
        allowNull: false,
        type: DataTypes.DATE,
        field: 'create_at',
        defaultValue: Sequelize.NOW,
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(WALLET_TABLE);
  },
};
