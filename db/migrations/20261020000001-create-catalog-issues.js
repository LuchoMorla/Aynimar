'use strict';

/**
 * Salud del catálogo — problemas detectados por producto y decisión del propietario.
 *
 * Una fila por (producto, tipo de problema). Mientras está 'open' solo puede
 * haber una por par: índice único PARCIAL (product_id, type) WHERE status='open'.
 * Las cerradas (decided/dismissed/resolved) quedan como registro histórico.
 * Sin datos de clientes.
 *
 * ADITIVA y reversible: up → CREATE TABLE IF NOT EXISTS; down → DROP TABLE IF
 * EXISTS (ninguna otra tabla la referencia). Borrar un producto borra sus issues.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "catalog_issues" (
        "id"              SERIAL       PRIMARY KEY,
        "product_id"      INTEGER      NOT NULL REFERENCES "products" ("id") ON DELETE CASCADE,
        "type"            VARCHAR(40)  NOT NULL,
        "severity"        VARCHAR(10)  NOT NULL CHECK ("severity" IN ('critical','high','medium','low')),
        "title"           TEXT         NOT NULL,
        "details"         JSONB        NOT NULL DEFAULT '{}'::jsonb,
        "suggestions"     JSONB        NOT NULL DEFAULT '[]'::jsonb,
        "source"          VARCHAR(10)  NOT NULL CHECK ("source" IN ('scan','import')),
        "fingerprint"     TEXT,
        "status"          VARCHAR(12)  NOT NULL DEFAULT 'open'
                          CHECK ("status" IN ('open','decided','dismissed','resolved')),
        "decision_action" VARCHAR(20),
        "decision_params" JSONB,
        "decision_note"   TEXT,
        "decided_by"      INTEGER,
        "decided_at"      TIMESTAMPTZ,
        "resolved_at"     TIMESTAMPTZ,
        "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "catalog_issues_open_uniq" ON "catalog_issues" ("product_id", "type") WHERE "status" = 'open';`
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "catalog_issues_status_idx" ON "catalog_issues" ("status");'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "catalog_issues";');
  },
};
