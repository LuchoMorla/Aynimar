'use strict';

/**
 * Migration: adds 'error_api_proveedor' to the orders.state_order ENUM.
 *
 * PostgreSQL does not support removing ENUM values, so the down() migration
 * cannot be fully automated. Document the manual step instead of silently
 * failing.
 *
 * Adding a value to an existing ENUM requires an ACCESS EXCLUSIVE lock on
 * the type, which is brief and safe for low-traffic tables.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_orders_state_order"
        ADD VALUE IF NOT EXISTS 'error_api_proveedor';
    `);
  },

  async down() {
    // PostgreSQL does not allow removing individual ENUM values.
    // To reverse this: drop the type and recreate it without the value,
    // then ALTER the column. Only safe if no rows use 'error_api_proveedor'.
    console.warn(
      "[migration down] 'error_api_proveedor' cannot be automatically removed " +
      'from enum_orders_state_order. Perform a manual ALTER TYPE if needed.'
    );
  },
};
