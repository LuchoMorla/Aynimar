'use strict';

const { PAYMENT_PROOF_TABLE, PAYMENT_PROOF_STATUS_VALUES } = require('../models/paymentProofModel');
const { ORDER_TABLE } = require('../models/orderModel');
const { USER_TABLE } = require('../models/userModel');

/** @param {import('sequelize').QueryInterface} queryInterface */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(PAYMENT_PROOF_TABLE, {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.DataTypes.INTEGER,
      },
      order_id: {
        allowNull: false,
        type: Sequelize.DataTypes.INTEGER,
        references: { model: ORDER_TABLE, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      file_url: {
        allowNull: false,
        type: Sequelize.DataTypes.TEXT,
      },
      uploaded_by_user_id: {
        allowNull: false,
        type: Sequelize.DataTypes.INTEGER,
        references: { model: USER_TABLE, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      status: {
        allowNull: false,
        type: Sequelize.DataTypes.ENUM(...PAYMENT_PROOF_STATUS_VALUES),
        defaultValue: 'pending',
      },
      reviewed_by_user_id: {
        allowNull: true,
        type: Sequelize.DataTypes.INTEGER,
        references: { model: USER_TABLE, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      reviewed_at: {
        allowNull: true,
        type: Sequelize.DataTypes.DATE,
        defaultValue: null,
      },
      review_note: {
        allowNull: true,
        type: Sequelize.DataTypes.TEXT,
        defaultValue: null,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DataTypes.DATE,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex(PAYMENT_PROOF_TABLE, ['order_id'], {
      name: 'idx_payment_proofs_order_id',
    });
    await queryInterface.addIndex(PAYMENT_PROOF_TABLE, ['order_id', 'status'], {
      name: 'idx_payment_proofs_order_id_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(PAYMENT_PROOF_TABLE);
  },
};
