const { Model, DataTypes, Sequelize } = require('sequelize');
const { USER_TABLE }     = require('./userModel');
const { RECYCLER_TABLE } = require('./recyclerModel');

const WALLET_TABLE = 'wallets';

const WalletSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },

  // Primary owner — any authenticated user regardless of role.
  // Added in migration 20260610000002.
  userId: {
    field: 'user_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: {
      model: USER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },

  // Kept nullable for backward compatibility with existing recycler wallets.
  // Will be deprecated once all wallets have been migrated to userId.
  recyclerId: {
    field: 'recycler_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: {
      model: RECYCLER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },

  credit: {
    allowNull: false,
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },

  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'create_at',
    defaultValue: Sequelize.NOW,
  },
};

class Wallet extends Model {
  static associate(models) {
    this.belongsTo(models.User,     { as: 'user',     foreignKey: 'userId' });
    this.belongsTo(models.Recycler, { as: 'recycler', foreignKey: 'recyclerId' });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: WALLET_TABLE,
      modelName: 'Wallet',
      timestamps: false,
    };
  }
}

module.exports = { WALLET_TABLE, WalletSchema, Wallet };