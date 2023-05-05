const { Model, DataTypes, Sequelize } = require('sequelize');
const { CUSTOMER_TABLE } = require('./customerModel');
const { ORDER_TABLE } = require('./orderModel');

const DEBIT_TABLE = 'debits';

const DebitSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  customerId: {
    field: 'customer_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: CUSTOMER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  orderId: {
    field: 'order_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: ORDER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  transactionId:{
    allowNull: false,
    field: 'transaction_id',
    type: DataTypes.STRING
  },
  amount: {
    allowNull: false,
    type: DataTypes.DECIMAL(10, 2), // 10 dígitos totales, 2 dígitos después del punto decimal
  },
  paymentDate: {
    allowNull: true,
    field: 'payment_date',
    type: DataTypes.DATE,
  },
  paymentStatus: {
    allowNull: true,
    field: 'payment_status',
    type: DataTypes.STRING
  },
  authorizationCode: {
    allowNull: true,
    field: 'codigo_autorizacion',
    type: DataTypes.STRING
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
  }
}


class Debit extends Model {

  static associate(models) {
    this.belongsTo(models.Customer, {
      as: 'customer',
    });
    this.belongsTo(models.Order, {
      as: 'order',
    });
    this.belongsToMany(models.Product, {
      as: 'items',
      through: models.OrderProduct,
      foreignKey: 'orderId',
      otherKey: 'productId'
    });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: DEBIT_TABLE,
      modelName: 'Debit',
      timestamps: true
    }
  }
}

module.exports = { Debit, DebitSchema, DEBIT_TABLE };