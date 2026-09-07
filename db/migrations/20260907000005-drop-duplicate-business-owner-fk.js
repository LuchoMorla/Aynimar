'use strict';

/**
 * Reparación cadena de migraciones — limpieza de FK duplicada.
 *
 * `20240701111122-add-keys` (antes de congelarse) pasaba `references` a
 * `changeColumn('business', 'business_owner_id', ...)`, lo que hacía que
 * Sequelize añadiera una FK DUPLICADA autogenerada
 * `business_business_owner_id_fkey1` — idéntica a la legítima
 * `business_business_owner_id_fkey` que crea el `createTable` de
 * `20240627111007-create-business-model`. Verificado presente en el esquema
 * real de staging.
 *
 * Efecto de esta migración:
 *   - BD nueva (con `20240701111122` ya congelada): la FK duplicada nunca se
 *     creó → `DROP CONSTRAINT IF EXISTS` es un no-op.
 *   - BD existente (staging / producción): elimina la FK duplicada redundante.
 *     La FK legítima `business_business_owner_id_fkey` permanece intacta, con
 *     el mismo comportamiento ON UPDATE CASCADE / ON DELETE SET NULL.
 *
 * Es una operación segura: sólo quita una constraint redundante, no cambia
 * ninguna semántica de integridad referencial.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE "business" DROP CONSTRAINT IF EXISTS "business_business_owner_id_fkey1";'
    );
  },

  async down() {
    // No se recrea: la FK duplicada nunca fue intencional y la FK legítima
    // (business_business_owner_id_fkey) nunca se toca.
  },
};
