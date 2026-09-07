'use strict';

/**
 * Corrige un efecto secundario NO intencional de
 * `20260907000001-allow-null-customer-id-on-orders.js`, detectado al
 * verificar el esquema real tras aplicarla en staging:
 *
 *   `queryInterface.changeColumn('orders', 'customer_id', { allowNull: true,
 *   ..., references: {...} })` — al incluir `references` junto con
 *   `allowNull`, el generador de SQL de Sequelize para Postgres agregó una
 *   constraint FK DUPLICADA (`orders_customer_id_fkey1`, idéntica a la ya
 *   existente `orders_customer_id_fkey`) en vez de emitir el
 *   `ALTER COLUMN ... DROP NOT NULL` esperado — `customer_id` seguía
 *   `NOT NULL` después de "migrar" exitosamente (confirmado con
 *   `information_schema`/`pg_attribute` reales, no solo con el mensaje de
 *   la CLI).
 *
 * Esta migración:
 *   1. Elimina la FK duplicada (la original, ya existente antes de esta
 *      ronda, queda intacta — mismo comportamiento onUpdate/onDelete).
 *   2. Vuelve a intentar el cambio de nulabilidad, esta vez SIN pasar
 *      `references` a `changeColumn` (la FK ya existe; no hace falta
 *      recrearla) — patrón que sí funcionó sin problemas para
 *      `orders.payment_method` en la migración 20260907000002.
 */

const { ORDER_TABLE } = require('../models/orderModel');
const { DataTypes } = require('sequelize');

const DUPLICATE_FK_NAME = 'orders_customer_id_fkey1';

module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.removeConstraint(ORDER_TABLE, DUPLICATE_FK_NAME);
    } catch (err) {
      // Si esta migración se corre en un entorno donde la constraint
      // duplicada nunca se creó (ej. una BD nueva que solo ve esta versión
      // corregida), no hay nada que eliminar — no es un error real.
      console.warn(`[migration] No se pudo eliminar ${DUPLICATE_FK_NAME} (puede que no exista): ${err.message}`);
    }

    await queryInterface.changeColumn(ORDER_TABLE, 'customer_id', {
      allowNull: true,
      type: DataTypes.INTEGER,
    });
  },

  async down(queryInterface) {
    await queryInterface.changeColumn(ORDER_TABLE, 'customer_id', {
      allowNull: false,
      type: DataTypes.INTEGER,
    });
    // No se recrea la FK duplicada — nunca fue intencional, y la FK
    // original (orders_customer_id_fkey) sigue existiendo sin interrupción.
  },
};
