'use strict';

// Pricing Engine (docs/PRICING_ENGINE_SPEC.md, sección C) — Paso 1.
// Snapshot histórico e inmutable del PVP vigente al momento de confirmar la
// orden. Nullable: filas existentes no pueden reconstruirse honestamente, y
// la captura empieza aquí sin backfill. NO se recalcula nunca después de
// escrito, aunque product.price cambie más tarde.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders_products', 'unit_price_gross', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('orders_products', 'unit_price_gross');
  },
};
