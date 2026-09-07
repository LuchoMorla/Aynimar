'use strict';

/**
 * Tabla de auditoría del reconciliador de Firebase Storage.
 *
 * Append-only. El reconciliador (scripts/storage-reconcile.js) escribe UNA fila
 * por objeto ANTES de borrarlo, sólo en modo --delete (que NO se ejecuta de
 * forma automática). En modo --dry-run (por defecto) esta tabla no se toca.
 *
 * Es una migración puramente ADITIVA y reversible:
 *   up   → CREATE TABLE IF NOT EXISTS  (no-op si ya existe)
 *   down → DROP TABLE IF EXISTS        (la tabla es sólo auditoría de una
 *          herramienta de mantenimiento; no la referencia ninguna otra tabla)
 *
 * No se registra como modelo Sequelize en db/models/index.js a propósito: el
 * reconciliador es un script standalone y no debe acoplarse al arranque de la
 * app.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "storage_cleanup_log" (
        "id"             BIGSERIAL PRIMARY KEY,
        "run_id"         VARCHAR(64)  NOT NULL,
        "report_id"      VARCHAR(64)  NOT NULL,
        "storage_path"   TEXT         NOT NULL,
        "size_bytes"     BIGINT,
        "md5_hash"       VARCHAR(64),
        "classification" VARCHAR(32)  NOT NULL,
        "reason"         TEXT,
        "action"         VARCHAR(16)  NOT NULL DEFAULT 'deleted',
        "operator"       VARCHAR(120),
        "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "storage_cleanup_log_run_id_idx" ON "storage_cleanup_log" ("run_id");'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "storage_cleanup_log_storage_path_idx" ON "storage_cleanup_log" ("storage_path");'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "storage_cleanup_log";');
  },
};
