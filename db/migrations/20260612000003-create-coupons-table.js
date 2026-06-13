'use strict';

const { COUPON_TABLE } = require('../models/couponModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(COUPON_TABLE, {
      id: {
        allowNull:     false,
        autoIncrement: true,
        primaryKey:    true,
        type:          Sequelize.INTEGER,
      },
      business_id: {
        allowNull:  false,
        type:       Sequelize.INTEGER,
        references: { model: 'business', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      code: {
        allowNull: false,
        type:      Sequelize.STRING(50),
      },
      type: {
        allowNull: false,
        type:      Sequelize.ENUM('PERCENTAGE', 'FIXED_AMOUNT'),
      },
      value: {
        allowNull: false,
        type:      Sequelize.DECIMAL(10, 2),
      },
      min_order_amount: {
        allowNull:    true,
        type:         Sequelize.DECIMAL(10, 2),
        defaultValue: null,
      },
      start_date: {
        allowNull:    true,
        type:         Sequelize.DATEONLY,
        defaultValue: null,
      },
      end_date: {
        allowNull:    true,
        type:         Sequelize.DATEONLY,
        defaultValue: null,
      },
      is_active: {
        allowNull:    false,
        type:         Sequelize.BOOLEAN,
        defaultValue: true,
      },
      created_at: {
        allowNull:    false,
        type:         Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex(COUPON_TABLE, ['business_id'], { name: 'coupons_business_id_idx' });
    await queryInterface.addIndex(COUPON_TABLE, ['code'],        { name: 'coupons_code_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(COUPON_TABLE);
  },
};
