'use strict';

const { DataTypes, Sequelize } = require('sequelize');

/**
 * Reparación cadena de migraciones (histórico congelado):
 *
 * Antes: `createTable(DEBIT_TABLE, DebitSchema)` importando el schema VIVO de
 * `models/debitModel.js`. Eso hace que el resultado en una BD nueva dependa
 * del estado actual del modelo (no determinista) y reproduce el mismo tipo de
 * fallo que tuvo `create-business-model`: si algún día se añade una columna al
 * modelo y su migración `addColumn`, una BD nueva la crearía dos veces y la
 * cadena abortaría con "column already exists".
 *
 * Se congela el schema a un snapshot inline. Este snapshot reproduce EXACTAMENTE
 * las 10 columnas + 2 FK que `debits` tiene hoy en el esquema real de staging
 * (verificado). Editar el cuerpo de una migración ya registrada no la
 * re-ejecuta; `CREATE TABLE IF NOT EXISTS` la hace no-op si la tabla ya existe.
 */

const DEBIT_TABLE = 'debits';
const CUSTOMER_TABLE = 'customers';
const ORDER_TABLE = 'orders';

const DebitSchemaFrozen = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  customerId: {
    field: 'customer_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: CUSTOMER_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  orderId: {
    field: 'order_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: ORDER_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  transactionId: {
    allowNull: false,
    field: 'transaction_id',
    type: DataTypes.STRING,
  },
  amount: {
    allowNull: false,
    type: DataTypes.DECIMAL(10, 2),
  },
  paymentDate: {
    allowNull: true,
    field: 'payment_date',
    type: DataTypes.DATE,
  },
  paymentStatus: {
    allowNull: true,
    field: 'payment_status',
    type: DataTypes.STRING,
  },
  authorizationCode: {
    allowNull: true,
    field: 'codigo_autorizacion',
    type: DataTypes.STRING,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  updatedAt: {
    allowNull: true,
    type: DataTypes.DATE,
    field: 'updated_at',
    defaultValue: Sequelize.NOW,
  },
};

module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable(DEBIT_TABLE, DebitSchemaFrozen);
  },

  async down(queryInterface) {
    await queryInterface.dropTable(DEBIT_TABLE);
  },
};
