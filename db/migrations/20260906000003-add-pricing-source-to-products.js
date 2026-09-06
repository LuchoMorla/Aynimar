'use strict';

/**
 * Migration: pricing authority tracking on products (Pricing Engine —
 * integración progresiva con catálogo, "pricingSource").
 *
 * New columns, all nullable, all additive — no existing row is touched:
 *
 *  - pricing_source           VARCHAR   nullable — 'legacy_sync' | 'manual' | 'engine' | NULL.
 *      NULL = sin evidencia de origen (productos previos a esta migración).
 *      NO se hace backfill: la interpretación operacional de NULL a partir de
 *      `source_provider` es responsabilidad de la capa de aplicación, no de
 *      esta migración — un valor NULL nunca se reescribe aquí como si fuera
 *      un hecho histórico conocido.
 *  - pricing_cost_snapshot    DECIMAL(10,2) nullable — costo usado la última
 *      vez que se APLICÓ un precio vía el Pricing Engine. NO es el costo
 *      actual del producto (eso sigue siendo `cost_price`) — es un snapshot
 *      histórico e inmutable de esa aplicación puntual.
 *  - pricing_calculated_price DECIMAL(10,2) nullable — PVP calculado/aprobado
 *      en esa misma aplicación.
 *  - pricing_applied_at       TIMESTAMP nullable — cuándo ocurrió esa aplicación.
 *
 * Los tres campos de snapshot solo deben poblarse cuando pricing_source =
 * 'engine'; para 'manual'/'legacy_sync'/NULL permanecen NULL — no se inventa
 * un snapshot para una aplicación que nunca pasó por el motor.
 *
 * Esta migración NO se ejecuta contra ninguna base de datos en esta fase —
 * solo se crea el archivo, sin correr `sequelize db:migrate`.
 */

const { PRODUCT_TABLE } = require('../models/productModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(PRODUCT_TABLE, 'pricing_source', {
      type:      Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
      comment:   "'legacy_sync' | 'manual' | 'engine' | NULL (sin evidencia de origen)",
    });

    await queryInterface.addColumn(PRODUCT_TABLE, 'pricing_cost_snapshot', {
      type:      Sequelize.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
      comment:   'Costo usado en la última aplicación vía Pricing Engine — NO el costo actual (ver cost_price)',
    });

    await queryInterface.addColumn(PRODUCT_TABLE, 'pricing_calculated_price', {
      type:      Sequelize.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
      comment:   'PVP calculado/aprobado en esa misma aplicación del Pricing Engine',
    });

    await queryInterface.addColumn(PRODUCT_TABLE, 'pricing_applied_at', {
      type:      Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
      comment:   'Fecha en que se aplicó ese precio calculado por el Pricing Engine',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(PRODUCT_TABLE, 'pricing_applied_at');
    await queryInterface.removeColumn(PRODUCT_TABLE, 'pricing_calculated_price');
    await queryInterface.removeColumn(PRODUCT_TABLE, 'pricing_cost_snapshot');
    await queryInterface.removeColumn(PRODUCT_TABLE, 'pricing_source');
  },
};
