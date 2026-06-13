'use strict';

/**
 * Migration: add dropshipping sync fields to products table.
 *
 * New columns:
 *  - external_id      VARCHAR  nullable — ID del producto en el proveedor (Dropi/Effi)
 *  - source_provider  VARCHAR  nullable — 'dropi' | 'effi' | null
 *  - last_sync_at     TIMESTAMP nullable — cuándo fue la última sincronización
 *  - images           TEXT     nullable — JSON array de URLs de imágenes adicionales
 *
 * All columns are nullable so existing products are unaffected.
 * A composite unique index on (external_id, source_provider) prevents
 * duplicate imports from the same provider.
 */

const { PRODUCT_TABLE } = require('../models/productModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(PRODUCT_TABLE, 'external_id', {
      type:      Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.addColumn(PRODUCT_TABLE, 'source_provider', {
      type:      Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.addColumn(PRODUCT_TABLE, 'last_sync_at', {
      type:      Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.addColumn(PRODUCT_TABLE, 'images', {
      type:      Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
      comment:   'JSON array de URLs de imágenes del producto',
    });

    // Prevents duplicate imports from the same provider.
    // Partial unique index (only when external_id IS NOT NULL).
    await queryInterface.addIndex(PRODUCT_TABLE, ['external_id', 'source_provider'], {
      unique: true,
      name:   'products_external_id_source_provider_unique',
      where:  { external_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      PRODUCT_TABLE,
      'products_external_id_source_provider_unique'
    );
    await queryInterface.removeColumn(PRODUCT_TABLE, 'images');
    await queryInterface.removeColumn(PRODUCT_TABLE, 'last_sync_at');
    await queryInterface.removeColumn(PRODUCT_TABLE, 'source_provider');
    await queryInterface.removeColumn(PRODUCT_TABLE, 'external_id');
  },
};
