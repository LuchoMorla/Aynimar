'use strict';

/**
 * Migration: adds order tracking fields and 'en_transito' state.
 *
 * Changes:
 *   1. Adds 'en_transito' to enum_orders_state_order.
 *      (PostgreSQL ADD VALUE is non-transactional — commits immediately.)
 *   2. Adds tracking_number VARCHAR(255) to orders.
 *   3. Adds carrier_name  VARCHAR(100)  to orders.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Extend ENUM — must run outside a transaction in PostgreSQL
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_orders_state_order"
        ADD VALUE IF NOT EXISTS 'en_transito';
    `);

    // 2 & 3. Add tracking columns (safe to run in the same statement block)
    await queryInterface.addColumn('orders', 'tracking_number', {
      type:         Sequelize.STRING(255),
      allowNull:    true,
      defaultValue: null,
    });

    await queryInterface.addColumn('orders', 'carrier_name', {
      type:         Sequelize.STRING(100),
      allowNull:    true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('orders', 'tracking_number');
    await queryInterface.removeColumn('orders', 'carrier_name');
    // 'en_transito' cannot be removed automatically from an ENUM in PostgreSQL.
    // Manual revert: drop the type and recreate it without 'en_transito',
    // then ALTER the column — only safe if no rows use 'en_transito'.
    console.warn(
      "[migration down] 'en_transito' cannot be auto-removed from " +
      'enum_orders_state_order. Perform a manual ALTER TYPE if needed.'
    );
  },
};
