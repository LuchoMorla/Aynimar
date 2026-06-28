'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');
const { WALLET_TABLE } = require('./walletModel');

const WALLET_TRANSACTION_TABLE = 'wallet_transactions';

const TRANSACTION_TYPES = ['sale', 'commission', 'redemption', 'adjustment'];
const TRANSACTION_DIRECTIONS = ['credit', 'debit'];

const WalletTransactionSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },

  walletId: {
    field: 'wallet_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: WALLET_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },

  // 'sale' | 'commission' | 'redemption' | 'adjustment'
  type: {
    allowNull: false,
    type: DataTypes.ENUM(...TRANSACTION_TYPES),
  },

  // 'credit' (ingreso al wallet) | 'debit' (egreso del wallet)
  direction: {
    allowNull: false,
    type: DataTypes.ENUM(...TRANSACTION_DIRECTIONS),
  },

  // Monto bruto del reciclable en USD (ej. 5.00)
  grossAmount: {
    field: 'gross_amount',
    allowNull: false,
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },

  // Comisión retenida por Aynimar (30% de gross). Solo aplica en type='sale'.
  commission: {
    allowNull: false,
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },

  // Créditos enteros acreditados al usuario (FLOOR(gross * 0.70))
  netCredits: {
    field: 'net_credits',
    allowNull: false,
    type: DataTypes.INTEGER,
  },

  // FK opcional al registro origen (payment_wastes.id u orders.id)
  referenceId: {
    field: 'reference_id',
    allowNull: true,
    type: DataTypes.INTEGER,
  },

  // 'payment_waste' | 'order'
  referenceType: {
    field: 'reference_type',
    allowNull: true,
    type: DataTypes.STRING(30),
  },

  notes: {
    allowNull: true,
    type: DataTypes.TEXT,
  },

  createdAt: {
    field: 'created_at',
    allowNull: false,
    type: DataTypes.DATE,
    defaultValue: Sequelize.NOW,
  },
};

class WalletTransaction extends Model {
  static associate(models) {
    this.belongsTo(models.Wallet, { as: 'wallet', foreignKey: 'walletId' });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: WALLET_TRANSACTION_TABLE,
      modelName: 'WalletTransaction',
      timestamps: false,
    };
  }
}

module.exports = {
  WALLET_TRANSACTION_TABLE,
  TRANSACTION_TYPES,
  TRANSACTION_DIRECTIONS,
  WalletTransactionSchema,
  WalletTransaction,
};
