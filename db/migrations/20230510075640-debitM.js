'use strict';

const { DataTypes, Sequelize } = require('sequelize');

/**
 * Reparación cadena de migraciones (histórico congelado):
 *
 * Esta migración es un DUPLICADO de `20230503190634-debitCard` (una semana
 * después). `debits` ya existe cuando corre → `CREATE TABLE IF NOT EXISTS` es
 * un no-op en cualquier BD. Se mantiene por integridad del historial
 * (`SequelizeMeta` ya la tiene registrada en staging/producción) pero se le
 * quita la dependencia del modelo vivo: el schema queda congelado, idéntico al
 * de `debitCard`, así el resultado nunca depende del estado actual del modelo.
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
