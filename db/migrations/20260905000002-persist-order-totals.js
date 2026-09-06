'use strict';

/**
 * Fase A — A5: totales de la orden persistidos.
 *
 * Hasta ahora `orders.total` era un getter VIRTUAL del modelo que dependía de
 * tener `items` cargados con su precio → devolvía `undefined` / 0 en el
 * dashboard y en cualquier cálculo de cobro. La columna real `orders.total`
 * (creada en 20250618150857-pago-contra-entrega) existía pero nunca se escribía.
 *
 * Esta migración SÓLO añade `subtotal` y `tax` (la columna `total` ya existe).
 * A partir de ahora, checkout() y confirm-cod() escriben los tres valores con
 * la fórmula única `Services/orderTotals.js#computeOrderTotals`.
 *
 * SIN BACKFILL (decisión 4, Fase B):
 *   NO se reconstruye el histórico con los precios ACTUALES de los productos
 *   — eso alteraría información financiera histórica con datos que no son los
 *   reales del momento de la compra.
 *   ⇒ Las órdenes anteriores a esta migración quedan con subtotal = tax =
 *      total = 0. Ese 0 significa "no registrado", NO "gratis". El total
 *      histórico real no es recuperable desde los datos actuales.
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
    // Sin UPDATE de backfill — ver cabecera.
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(ORDER_TABLE, 'subtotal');
    await queryInterface.removeColumn(ORDER_TABLE, 'tax');
    // `total` no se elimina aquí: es anterior a esta migración.
  },
};
