'use strict';

const { DataTypes, Sequelize } = require('sequelize');

/**
 * Reparación cadena de migraciones (histórico congelado):
 *
 * `payments_wastes` ya se crea en `20220727092613-first-migration` (y otra vez
 * en `20240302221124-NewSuperMigration`). Cuando esta migración corre, la tabla
 * ya existe → `CREATE TABLE IF NOT EXISTS` es un NO-OP en cualquier BD.
 *
 * Se mantiene por integridad del historial (`SequelizeMeta` ya la registra en
 * staging/producción). Se le quita la dependencia del modelo vivo: el schema
 * queda congelado, idéntico al de `first-migration` y al esquema real de
 * staging (verificado). No introduce ningún cambio funcional.
 */

const PAYMENT_WASTE_TABLE = 'payments_wastes';
const PAYMENT_TABLE = 'payments';
const WASTE_TABLE = 'wastes';

const PaymentWasteSchemaFrozen = {
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
  amount: {
    allowNull: false,
    type: DataTypes.INTEGER,
  },
  paymentId: {
    field: 'payment_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: PAYMENT_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  wasteId: {
    field: 'waste_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: WASTE_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
};

module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable(PAYMENT_WASTE_TABLE, PaymentWasteSchemaFrozen);
  },

  async down(queryInterface) {
    await queryInterface.dropTable(PAYMENT_WASTE_TABLE);
  },
};
