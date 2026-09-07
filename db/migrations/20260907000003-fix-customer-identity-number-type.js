'use strict';

/**
 * Corrige `customers.identity_number`: se creó como `integer`
 * (`20220727092613-first-migration.js`) pero es un identificador ecuatoriano
 * (cédula o RUC), no una cantidad — el modelo (`db/models/customerModel.js`)
 * ya lo declara `DataTypes.STRING`.
 *
 * Impacto confirmado con el tipo `integer` real:
 *   - Un RUC de 13 dígitos (ej. "1792060346001") excede el rango de
 *     `integer` (máx. 2,147,483,647) → el INSERT falla con
 *     "value out of range for type integer".
 *   - Una cédula con ceros a la izquierda pierde esos ceros silenciosamente
 *     (ej. "0000000001" se guarda como el entero 1).
 *
 * Verificado antes de escribir esta migración (staging, solo lectura): 14
 * filas existentes, sin NULLs, valores 0/1/99 — la conversión
 * integer → varchar(255) es lossless para TODOS los datos actuales
 * (`identity_number::varchar`). No se requiere backfill ni tratamiento
 * especial.
 *
 * Se usa SQL explícito (`USING ... ::varchar` / `::integer`) en vez de
 * `queryInterface.changeColumn` porque Sequelize no expone una cláusula
 * `USING` para el cambio de tipo, y Postgres la requiere para este ALTER.
 */

const { CUSTOMER_TABLE } = require('../models/customerModel');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "${CUSTOMER_TABLE}"
      ALTER COLUMN "identity_number" TYPE VARCHAR(255)
      USING "identity_number"::VARCHAR(255)
    `);
  },

  async down(queryInterface) {
    // Solo revierte limpiamente si, para ese entonces, todos los valores
    // siguen siendo representables como integer — de lo contrario el down()
    // falla explícitamente (correcto: no se trunca ni se inventa un valor).
    await queryInterface.sequelize.query(`
      ALTER TABLE "${CUSTOMER_TABLE}"
      ALTER COLUMN "identity_number" TYPE INTEGER
      USING "identity_number"::INTEGER
    `);
  },
};
