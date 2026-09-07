'use strict';

const { DataTypes } = require('sequelize');

/**
 * Reparación cadena de migraciones (histórico congelado):
 *
 * Antes: `createTable(BUSINESS_OWNER, BussinesOwnerSchema)` con el schema VIVO
 * de `models/businessOwnerModel.js`. Se congela a un snapshot inline para que
 * el resultado en una BD nueva no dependa del estado actual del modelo.
 *
 * `identity_number` se congela como INTEGER: así es como se creó
 * históricamente en producción; la migración `20240715142749-updates-columns-1`
 * la convierte después a STRING (mismo camino que en producción). Estado final:
 * varchar(255) nullable, idéntico al esquema real de staging (verificado).
 */

const BUSINESS_OWNER = 'bussiness_owner';
const USER_TABLE = 'users';

const BussinesOwnerSchemaFrozen = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  name: {
    allowNull: false,
    type: DataTypes.STRING,
  },
  lastName: {
    allowNull: false,
    type: DataTypes.STRING,
    field: 'last_name',
  },
  identityNumber: {
    allowNull: true,
    type: DataTypes.INTEGER,
    field: 'identity_number',
  },
  userId: {
    field: 'user_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    unique: true,
    references: { model: USER_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
};

module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable(BUSINESS_OWNER, BussinesOwnerSchemaFrozen);
  },
  async down(queryInterface) {
    await queryInterface.dropTable(BUSINESS_OWNER);
  },
};
