'use strict';

/**
 * Automatización de pedidos (docs/ORDER_AUTOMATION.md).
 *
 * ADITIVA y reversible:
 *  - orders: is_test (prueba ≠ real), dispatch_started_at (marca del envío en
 *    curso para detectar envíos ambiguos), cod_status / cod_collected_amount
 *    (conciliación COD), shipping_cost / provider_fees (costes reales),
 *    dropi_status_history ([{status, group, at}] para medir el plazo real).
 *  - order_exceptions: cola de revisión humana. Un solo registro ABIERTO por
 *    (order_id, type) — índice único parcial — para que dos eventos iguales no
 *    dupliquen la excepción.
 * down → quita columnas y tabla (ninguna otra tabla referencia order_exceptions).
 * Sin datos de clientes en order_exceptions.details (solo ids y motivos).
 */

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "is_test"              BOOLEAN       NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "dispatch_started_at"  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "cod_status"           VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "cod_collected_amount" DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS "shipping_cost"        DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS "provider_fees"        DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS "dropi_status_history" JSONB;
    `);
    await q(`
      CREATE TABLE IF NOT EXISTS "order_exceptions" (
        "id"          SERIAL       PRIMARY KEY,
        "order_id"    INTEGER      NOT NULL REFERENCES "orders" ("id") ON DELETE CASCADE,
        "type"        VARCHAR(30)  NOT NULL,
        "details"     JSONB        NOT NULL DEFAULT '{}'::jsonb,
        "status"      VARCHAR(10)  NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','resolved')),
        "resolution"  VARCHAR(20),
        "note"        TEXT,
        "resolved_by" INTEGER,
        "resolved_at" TIMESTAMPTZ,
        "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "order_exceptions_open_uniq" ON "order_exceptions" ("order_id", "type") WHERE "status" = 'open';`);
    await q('CREATE INDEX IF NOT EXISTS "order_exceptions_status_idx" ON "order_exceptions" ("status");');
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS "order_exceptions";');
    await q(`
      ALTER TABLE "orders"
        DROP COLUMN IF EXISTS "is_test",
        DROP COLUMN IF EXISTS "dispatch_started_at",
        DROP COLUMN IF EXISTS "cod_status",
        DROP COLUMN IF EXISTS "cod_collected_amount",
        DROP COLUMN IF EXISTS "shipping_cost",
        DROP COLUMN IF EXISTS "provider_fees",
        DROP COLUMN IF EXISTS "dropi_status_history";
    `);
  },
};
