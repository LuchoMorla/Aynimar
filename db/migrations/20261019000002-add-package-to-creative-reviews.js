'use strict';

/**
 * Social publisher — una revisión de Telegram puede referirse a un PAQUETE
 * (pieza-versión + redes + textos + horarios) en vez de a un vídeo suelto.
 *
 *  piece_id      → social_pieces.id (NULL = revisión F2 de vídeo, como hasta ahora)
 *  package_hash  → sha256 del paquete enviado a revisión; aprobar solo vale si coincide
 *  superseded_at → el paquete cambió o se reenvió: los botones de esta revisión ya no valen
 *
 * ADITIVA: solo columnas nullable; el modelo CreativeReview no las declara (el flujo
 * F2 de vídeos sigue funcionando aunque esta migración no se haya aplicado).
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "creative_reviews"
        ADD COLUMN IF NOT EXISTS "piece_id"      INTEGER,
        ADD COLUMN IF NOT EXISTS "package_hash"  CHAR(64),
        ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMPTZ;`);
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "creative_reviews_piece_idx" ON "creative_reviews" ("piece_id") WHERE "piece_id" IS NOT NULL;'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "creative_reviews_piece_idx";');
    await queryInterface.sequelize.query(`
      ALTER TABLE "creative_reviews"
        DROP COLUMN IF EXISTS "superseded_at",
        DROP COLUMN IF EXISTS "package_hash",
        DROP COLUMN IF EXISTS "piece_id";`);
  },
};
