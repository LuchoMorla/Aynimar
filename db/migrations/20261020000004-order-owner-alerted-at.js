'use strict';

/**
 * Aviso Telegram al propietario por cada pedido real confirmado.
 * ADITIVA y reversible: orders.owner_alerted_at (nullable). Se fija con un UPDATE
 * condicionado (WHERE owner_alerted_at IS NULL) antes de enviar: un solo aviso por pedido.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "owner_alerted_at" TIMESTAMPTZ;');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "owner_alerted_at";');
  },
};
