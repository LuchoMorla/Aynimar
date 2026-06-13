'use strict';

/**
 * Migration: refactor wallets to belong to User instead of Recycler.
 *
 * Problem: wallets.recycler_id means only users with a recycler profile
 * can hold green credits. Customers who want to redeem credits at checkout
 * have no wallet — blocking Phase 3 (circular economy checkout).
 *
 * Solution:
 *   1. Add wallets.user_id  → FK to users (nullable first for safe backfill)
 *   2. Backfill user_id from the linked recycler row
 *   3. Make recycler_id nullable (not dropped — avoids breaking existing
 *      queries until walletService is fully migrated)
 *   4. Add UNIQUE constraint on user_id (one wallet per user)
 *
 * After this migration any user (customer, recycler, or both) can have
 * exactly one wallet with green credits.
 */

const { WALLET_TABLE }   = require('../models/walletModel');
const { USER_TABLE }     = require('../models/userModel');
const { RECYCLER_TABLE } = require('../models/recyclerModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── Step 1: add user_id column (nullable to allow backfill) ──────
    await queryInterface.addColumn(WALLET_TABLE, 'user_id', {
      type:       Sequelize.INTEGER,
      allowNull:  true,
      references: { model: USER_TABLE, key: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'SET NULL',
    });

    // ── Step 2: backfill user_id from the recyclers table ────────────
    await queryInterface.sequelize.query(`
      UPDATE ${WALLET_TABLE} w
      SET    user_id = r.user_id
      FROM   ${RECYCLER_TABLE} r
      WHERE  r.id = w.recycler_id
        AND  w.recycler_id IS NOT NULL;
    `);

    // ── Step 3: make recycler_id nullable (backward compat) ──────────
    await queryInterface.changeColumn(WALLET_TABLE, 'recycler_id', {
      type:      Sequelize.INTEGER,
      allowNull: true,
    });

    // ── Step 4: unique constraint — one wallet per user ───────────────
    // Applied only to non-null user_id rows (wallets created before
    // this migration that have no user_id are not constrained).
    await queryInterface.addIndex(WALLET_TABLE, ['user_id'], {
      unique: true,
      name:   'wallets_user_id_unique',
      where:  { user_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(WALLET_TABLE, 'wallets_user_id_unique');

    // Restore recycler_id to NOT NULL before removing the new column.
    await queryInterface.changeColumn(WALLET_TABLE, 'recycler_id', {
      type:      Sequelize.INTEGER,
      allowNull: false,
    });

    await queryInterface.removeColumn(WALLET_TABLE, 'user_id');
  },
};
