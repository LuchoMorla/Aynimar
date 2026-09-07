'use strict';

const { DataTypes } = require('sequelize');
const { BUSINESS_TABLE } = require('../models/businessModel');

/**
 * Reparación cadena de migraciones (histórico congelado):
 *
 * Antes esta migración hacía:
 *   changeColumn(BUSINESS_TABLE, BusinessSchema.ownerId.field, BusinessSchema.ownerId)
 * pasando un objeto con `references`. El generador de SQL de Sequelize para
 * Postgres, al recibir `references` en un changeColumn, NO emite
 * `ALTER COLUMN`, sino `ALTER TABLE ... ADD FOREIGN KEY (...)` — y como la FK
 * `business_business_owner_id_fkey` ya existe (la crea el createTable de
 * `20240627111007-create-business-model`), Postgres añade una FK DUPLICADA
 * con nombre autogenerado `business_business_owner_id_fkey1` (idéntica,
 * inofensiva pero basura). Verificado en el esquema real de staging.
 *
 * La FK correcta ya existe desde el createTable. Aquí sólo se asegura el
 * tipo / nullability de la columna, sin `references`. Editar el cuerpo de una
 * migración ya registrada NO la re-ejecuta (sequelize-cli rastrea por nombre
 * de archivo). En una BD nueva ya no se genera la FK duplicada.
 * La limpieza de la FK duplicada preexistente en staging/producción la hace
 * `20260907000005-drop-duplicate-business-owner-fk`.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.changeColumn(BUSINESS_TABLE, 'business_owner_id', {
      type: DataTypes.INTEGER,
      allowNull: false,
    });
  },

  async down() {
    // La migración original tenía down() vacío; se mantiene.
  },
};
