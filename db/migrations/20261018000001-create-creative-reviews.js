'use strict';

/**
 * F2 — revisión de piezas creativas (vídeos) aprobadas desde Telegram.
 *
 * Una fila por vídeo enviado a revisión. `ref` es el id opaco que viaja en el
 * callback_data firmado. La decisión es una transición atómica desde 'pending'
 * (UPDATE ... WHERE status='pending'). production_cost_usd = coste de producir
 * la pieza (0 para el motor ffmpeg; NULL = desconocido). Sin datos de clientes.
 *
 * ADITIVA y reversible: up → CREATE TABLE IF NOT EXISTS; down → DROP TABLE IF
 * EXISTS (ninguna otra tabla la referencia).
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "creative_reviews" (
        "ref"                 VARCHAR(32)  PRIMARY KEY,
        "product_id"          INTEGER,
        "variant"             VARCHAR(8),
        "network"             VARCHAR(20),
        "utm_link"            TEXT,
        "caption"             TEXT,
        "telegram_file_id"    TEXT,
        "telegram_message_id" BIGINT,
        "status"              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                              CHECK ("status" IN ('pending','approved','rejected','changes_requested')),
        "change_request"      TEXT,
        "production_cost_usd" NUMERIC(10,4),
        "decided_at"          TIMESTAMPTZ,
        "decided_by"          BIGINT,
        "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "creative_reviews_created_at_idx" ON "creative_reviews" ("created_at" DESC);'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "creative_reviews";');
  },
};
