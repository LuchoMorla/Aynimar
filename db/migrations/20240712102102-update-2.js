'use strict';

const { DataTypes, Sequelize } = require('sequelize');

/**
 * Reparación cadena de migraciones (histórico congelado):
 *
 * Antes: `createTable(OFFER_TABLE, OfferSchema)` con el schema VIVO de
 * `models/offersModel.js`. Es la primera (y única) creación de `offers`;
 * ninguna migración posterior la altera, así que si el modelo `Offer` crece,
 * una BD nueva obtendría columnas que producción no tiene. Se congela a un
 * snapshot inline idéntico al esquema real de `offers` en staging (verificado:
 * id, created_at, status, payment_id + FK a payments).
 */

const OFFER_TABLE = 'offers';
const PAYMENT_TABLE = 'payments';

const OfferSchemaFrozen = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  status: {
    allowNull: false,
    type: DataTypes.STRING,
    defaultValue: 'pending',
  },
  paymentId: {
    field: 'payment_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: PAYMENT_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
};

module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable(OFFER_TABLE, OfferSchemaFrozen);
  },

  async down(queryInterface) {
    await queryInterface.dropTable(OFFER_TABLE);
  },
};
