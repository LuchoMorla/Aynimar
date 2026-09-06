'use strict';

/**
 * Fase A — A5: totales de la orden persistidos.
 *
 * Hasta ahora `orders.total` era un getter VIRTUAL del modelo que dependía de
 * tener `items` cargados con su precio → devolvía `undefined` / 0 en el
 * dashboard y en cualquier cálculo de cobro. La columna real `orders.total`
 * (creada en 20250618150857-pago-contra-entrega) existía pero nunca se escribía.
 *
 * Esta migración:
 *   - añade `subtotal` y `tax` (la columna `total` ya existe)
 *   - backfill best-effort de filas existentes: subtotal = Σ(cantidad × precio
 *     actual del producto); tax = 0; total = subtotal. Las órdenes nuevas
 *     escriben los tres valores correctamente al checkout / confirm-cod.
 */

const { ORDER_TABLE } = require('../models/orderModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(ORDER_TABLE, 'subtotal', {
      type: Sequelize.DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn(ORDER_TABLE, 'tax', {
      type: Sequelize.DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    });

    // Backfill best-effort de órdenes ya existentes.
    await queryInterface.sequelize.query(`
      UPDATE "${ORDER_TABLE}" o
         SET "subtotal" = sub.s,
             "total"    = sub.s
        FROM (
          SELECT op."order_id" AS oid,
                 COALESCE(SUM(op."amount" * p."price"), 0) AS s
            FROM "orders_products" op
            JOIN "products" p ON p."id" = op."product_id"
           GROUP BY op."order_id"
        ) sub
       WHERE o."id" = sub.oid
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(ORDER_TABLE, 'subtotal');
    await queryInterface.removeColumn(ORDER_TABLE, 'tax');
    // `total` no se elimina aquí: es anterior a esta migración.
  },
};
