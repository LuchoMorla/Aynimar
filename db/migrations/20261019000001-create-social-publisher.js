'use strict';

/**
 * Social publisher — calendario editorial + cola de publicación (ver docs/SOCIAL_PUBLISHER.md).
 *
 *  social_campaigns        campaña (producto, objetivo, público, concepto, tipo de contenido)
 *  social_pieces           versión EXACTA de una pieza: ref + version + sha256 del mp4
 *  social_posts            publicación planificada por red; es a la vez la fila de la cola
 *                          (Postgres, sin Redis). UNIQUE (piece_id, network): una pieza-versión
 *                          va a una red UNA sola vez y por UN solo canal (api propia | buffer | manual).
 *  social_approval_events  historial de aprobaciones (enviado, aprobado, rechazado, invalidado…)
 *
 * Sin datos de clientes. ADITIVA: no toca tablas existentes (la columna nueva de
 * creative_reviews va en 20261019000002). down → DROP TABLE IF EXISTS en orden inverso.
 */

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "social_campaigns" (
        "id"           SERIAL PRIMARY KEY,
        "product_id"   INTEGER,
        "name"         VARCHAR(120) NOT NULL,
        "objective"    TEXT,
        "audience"     TEXT,
        "concept"      TEXT,
        "content_type" VARCHAR(30),
        "created_by"   INTEGER,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
      );`);
    await q(`
      CREATE TABLE IF NOT EXISTS "social_pieces" (
        "id"               SERIAL PRIMARY KEY,
        "campaign_id"      INTEGER NOT NULL REFERENCES "social_campaigns"("id") ON DELETE RESTRICT,
        "ref"              VARCHAR(32) NOT NULL,
        "version"          INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
        "video_sha256"     CHAR(64) NOT NULL CHECK ("video_sha256" ~ '^[0-9a-f]{64}$'),
        "video_url"        TEXT,
        "telegram_file_id" TEXT,
        "width"            INTEGER,
        "height"           INTEGER,
        "duration_s"       NUMERIC(8,2),
        "bytes"            BIGINT,
        "approval_status"  VARCHAR(20) NOT NULL DEFAULT 'draft'
                           CHECK ("approval_status" IN ('draft','pending','approved','rejected','changes_requested','invalidated')),
        "review_ref"       VARCHAR(32),
        "approved_hash"    CHAR(64),
        "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "social_pieces_ref_version_uq" UNIQUE ("ref", "version")
      );`);
    await q(`
      CREATE TABLE IF NOT EXISTS "social_posts" (
        "id"                  SERIAL PRIMARY KEY,
        "piece_id"            INTEGER NOT NULL REFERENCES "social_pieces"("id") ON DELETE RESTRICT,
        "network"             VARCHAR(20) NOT NULL CHECK ("network" IN ('instagram','facebook','tiktok','youtube','mock')),
        "channel"             VARCHAR(20) NOT NULL DEFAULT 'api' CHECK ("channel" IN ('api','buffer','manual')),
        "scheduled_at"        TIMESTAMPTZ NOT NULL,
        "timezone"            VARCHAR(64) NOT NULL DEFAULT 'America/Guayaquil',
        "caption"             TEXT NOT NULL,
        "utm_link"            TEXT,
        "status"              VARCHAR(20) NOT NULL DEFAULT 'draft'
                              CHECK ("status" IN ('draft','queued','publishing','published','failed','manual_required','blocked')),
        "approved_hash"       CHAR(64),
        "approved_review_ref" VARCHAR(32),
        "attempts"            INTEGER NOT NULL DEFAULT 0,
        "max_attempts"        INTEGER NOT NULL DEFAULT 5,
        "next_attempt_at"     TIMESTAMPTZ,
        "locked_at"           TIMESTAMPTZ,
        "locked_by"           VARCHAR(64),
        "last_error"          TEXT,
        "external_id"         TEXT,
        "external_url"        TEXT,
        "published_at"        TIMESTAMPTZ,
        "verified_at"         TIMESTAMPTZ,
        "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "social_posts_piece_network_uq" UNIQUE ("piece_id", "network")
      );`);
    await q(`CREATE INDEX IF NOT EXISTS "social_posts_due_idx" ON "social_posts" ("next_attempt_at") WHERE "status" = 'queued';`);
    await q(`CREATE INDEX IF NOT EXISTS "social_posts_scheduled_idx" ON "social_posts" ("scheduled_at");`);
    await q(`
      CREATE TABLE IF NOT EXISTS "social_approval_events" (
        "id"           SERIAL PRIMARY KEY,
        "piece_id"     INTEGER NOT NULL REFERENCES "social_pieces"("id") ON DELETE RESTRICT,
        "review_ref"   VARCHAR(32),
        "event"        VARCHAR(30) NOT NULL,
        "package_hash" CHAR(64),
        "actor"        VARCHAR(40),
        "note"         TEXT,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
      );`);
    await q(`CREATE INDEX IF NOT EXISTS "social_approval_events_piece_idx" ON "social_approval_events" ("piece_id", "created_at");`);
  },

  async down(queryInterface) {
    for (const t of ['social_approval_events', 'social_posts', 'social_pieces', 'social_campaigns']) {
      await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "${t}";`);
    }
  },
};
