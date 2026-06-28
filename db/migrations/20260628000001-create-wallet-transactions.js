'use strict';

const { WALLET_TRANSACTION_TABLE, TRANSACTION_TYPES, TRANSACTION_DIRECTIONS } =
  require('../models/walletTransactionModel');
const { WALLET_TABLE } = require('../models/walletModel');

/** @param {import('sequelize').QueryInterface} queryInterface */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(WALLET_TRANSACTION_TABLE, {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.DataTypes.INTEGER,
      },
      wallet_id: {
        allowNull: false,
        type: Sequelize.DataTypes.INTEGER,
        references: { model: WALLET_TABLE, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      type: {
        allowNull: false,
        type: Sequelize.DataTypes.ENUM(...TRANSACTION_TYPES),
      },
      direction: {
        allowNull: false,
        type: Sequelize.DataTypes.ENUM(...TRANSACTION_DIRECTIONS),
      },
      gross_amount: {
        allowNull: false,
        type: Sequelize.DataTypes.DECIMAL(10, 2),
        defaultValue: 0,
      },
      commission: {
        allowNull: false,
        type: Sequelize.DataTypes.DECIMAL(10, 2),
        defaultValue: 0,
      },
      net_credits: {
        allowNull: false,
        type: Sequelize.DataTypes.INTEGER,
      },
      reference_id: {
        allowNull: true,
        type: Sequelize.DataTypes.INTEGER,
      },
      reference_type: {
        allowNull: true,
        type: Sequelize.DataTypes.STRING(30),
      },
      notes: {
        allowNull: true,
        type: Sequelize.DataTypes.TEXT,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DataTypes.DATE,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex(WALLET_TRANSACTION_TABLE, ['wallet_id'], {
      name: 'idx_wallet_transactions_wallet_id',
    });
    await queryInterface.addIndex(WALLET_TRANSACTION_TABLE, ['reference_id', 'reference_type'], {
      name: 'idx_wallet_transactions_reference',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(WALLET_TRANSACTION_TABLE);
  },
};
