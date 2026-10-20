'use strict';

/**
 * Seguimiento público del pedido con token opaco (no id secuencial).
 * ADITIVA y reversible: orders.tracking_token (único, nullable). Se genera al
 * pedirlo el dueño (GET /orders/mine/progress); los pedidos antiguos no lo tienen
 * hasta entonces.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tracking_token" VARCHAR(64);');
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS "orders_tracking_token_uniq" ON "orders" ("tracking_token");');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "orders_tracking_token_uniq";');
    await queryInterface.sequelize.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "tracking_token";');
  },
};
