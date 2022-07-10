const { Model, DataTypes, Sequelize } = require('sequelize');

const { PAYMENT_TABLE } = require('./paymentModel');
const { WASTE_TABLE } = require('./wasteModel');

const PAYMENT_WASTE_TABLE = 'payments_wastes';

const PaymentWasteSchema =  {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  amount: {
    allowNull: false,
    type: DataTypes.INTEGER
  },
  paymentId: {
    field: 'payment_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: PAYMENT_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  wasteId: {
    field: 'waste_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: WASTE_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  }
}

class PaymentWaste extends Model {

  static associate(models) {
    //
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: PAYMENT_WASTE_TABLE,
      modelName: 'PaymentWaste',
      timestamps: false
    }
  }
}

module.exports = { PaymentWaste, PaymentWasteSchema, PAYMENT_WASTE_TABLE };