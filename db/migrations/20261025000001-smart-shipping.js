'use strict';

/**
 * Smart Shipping, Fase B (informe ops-ceo-cto/informes/smart-shipping/01-fase-a.md §4.4).
 * ADITIVA: tabla nueva shipping_quotes + columnas anulables en orders. Con el flag
 * app_settings.smart_shipping apagado nada las lee ni escribe (orderModel no las declara:
 * se escriben con UPDATE explícito solo con el flag encendido).
 * down → DROP de la tabla y de las columnas (se pierde el historial de cotizaciones).
 * NO ejecutada en ninguna BD real al crearla; se aplica en el prestart del deploy.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS shipping_quotes (
      id             UUID PRIMARY KEY,
      order_id       INTEGER      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      user_id        INTEGER      NOT NULL,
      city_key       VARCHAR(120) NOT NULL,
      dropi_city_id  INTEGER      NOT NULL,
      payment_method VARCHAR(12)  NOT NULL CHECK (payment_method IN ('cod','deuna')),
      cart_hash      VARCHAR(64)  NOT NULL,
      options        JSONB        NOT NULL,
      source         VARCHAR(20)  NOT NULL,
      rates_as_of    VARCHAR(40)  NULL,
      expires_at     TIMESTAMPTZ  NOT NULL,
      used_at        TIMESTAMPTZ  NULL,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
    )`);
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS shipping_quotes_order_idx ON shipping_quotes (order_id)');
    await queryInterface.sequelize.query(`ALTER TABLE "orders"
      ADD COLUMN IF NOT EXISTS "shipping_quote_id"    UUID NULL,
      ADD COLUMN IF NOT EXISTS "shipping_carrier_id"  INTEGER NULL,
      ADD COLUMN IF NOT EXISTS "shipping_charge"      DECIMAL(10,2) NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "shipping_cost_quoted" DECIMAL(10,2) NULL`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE "orders"
      DROP COLUMN IF EXISTS "shipping_quote_id",
      DROP COLUMN IF EXISTS "shipping_carrier_id",
      DROP COLUMN IF EXISTS "shipping_charge",
      DROP COLUMN IF EXISTS "shipping_cost_quoted"`);
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS shipping_quotes');
  },
};
