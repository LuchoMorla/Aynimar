'use strict';

// Pricing Engine (docs/PRICING_ENGINE_SPEC.md, sección C) — Paso 1.
// Snapshot histórico e inmutable del costo de producto vigente al momento de
// confirmar la orden. Nullable = "costo desconocido en ese momento" (espeja
// products.cost_price, que hoy solo tiene dos estados: número real o NULL —
// nunca 0 por defecto). No confundir NULL con 0 en ningún consumidor futuro.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders_products', 'unit_cost_snapshot', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('orders_products', 'unit_cost_snapshot');
  },
};
