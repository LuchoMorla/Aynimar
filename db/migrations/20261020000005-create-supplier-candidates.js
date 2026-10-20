'use strict';

/**
 * Proveedores alternativos (candidatos de Dropi) por producto de la tienda.
 *
 * Tabla aparte de catalog_issues: un issue es «un problema del producto», un
 * candidato es «un artículo de Dropi que podría servirlo», con estado y auditoría
 * propios. Una fila por (producto, id Dropi, variante). Sin datos de clientes.
 *
 * Estados: propuesto → preparado_preferente | descartado | aprobado_por_propietario.
 * Como mucho UN preparado_preferente por producto (índice único parcial).
 * `preparado_preferente` NO toca el producto ni los pedidos: es una propuesta lista.
 *
 * ADITIVA y reversible: up → CREATE TABLE IF NOT EXISTS; down → DROP TABLE IF EXISTS.
 */

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "supplier_candidates" (
        "id"                 SERIAL        PRIMARY KEY,
        "product_id"         INTEGER       NOT NULL REFERENCES "products" ("id") ON DELETE CASCADE,
        "dropi_product_id"   VARCHAR(12)   NOT NULL,
        "dropi_variation_id" VARCHAR(12),
        "name"               TEXT,
        "supplier_id"        VARCHAR(20),
        "supplier_name"      TEXT,
        "supplier_verified"  BOOLEAN,
        "supplier_premium"   BOOLEAN,
        "cost"               DECIMAL(10,2),
        "stock"              INTEGER,
        "stock_checked_at"   TIMESTAMPTZ,
        "freight"            DECIMAL(10,2),
        "freight_source"     VARCHAR(120),
        "image_url"          TEXT,
        "image_hash"         VARCHAR(32),
        "attributes"         JSONB         NOT NULL DEFAULT '{}'::jsonb,
        "scores"             JSONB         NOT NULL DEFAULT '{}'::jsonb,
        "margin"             JSONB         NOT NULL DEFAULT '{}'::jsonb,
        "classification"     VARCHAR(10)   NOT NULL CHECK ("classification" IN ('EXACTO','SIMILAR','DISTINTO')),
        "evidence"           JSONB         NOT NULL DEFAULT '{}'::jsonb,
        "status"             VARCHAR(30)   NOT NULL DEFAULT 'propuesto'
                             CHECK ("status" IN ('propuesto','preparado_preferente','descartado','aprobado_por_propietario')),
        "source"             VARCHAR(30)   NOT NULL,
        "history"            JSONB         NOT NULL DEFAULT '[]'::jsonb,
        "created_at"         TIMESTAMPTZ   NOT NULL DEFAULT now(),
        "updated_at"         TIMESTAMPTZ   NOT NULL DEFAULT now()
      );
    `);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "supplier_candidates_uniq"
               ON "supplier_candidates" ("product_id", "dropi_product_id", (COALESCE("dropi_variation_id", '')));`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "supplier_candidates_one_preferred"
               ON "supplier_candidates" ("product_id") WHERE "status" = 'preparado_preferente';`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "supplier_candidates";');
  },
};
