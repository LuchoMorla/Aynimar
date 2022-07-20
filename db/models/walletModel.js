const { Model, DataTypes, Sequelize } = require('sequelize');
const { RECYCLER_TABLE } = require('./recyclerModel');

const WALLET_TABLE = 'wallets';

const WalletSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  recyclerId: {
    field: 'recycler_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    unique: true,
    references: {
      model: RECYCLER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  credit: {
    allowNull: true,
    type: DataTypes.INTEGER,
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
    this.belongsTo(models.Recycler, {
      as: 'recycler',
    });
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