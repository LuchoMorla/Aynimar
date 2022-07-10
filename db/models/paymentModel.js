const { Model, DataTypes, Sequelize } = require('sequelize');
const { RECYCLER_TABLE } = require('./recyclerModel');

const PAYMENT_TABLE = 'payments';

const PaymentSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  recyclerId: {
    field: 'recycler_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: RECYCLER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  total: {
    type: DataTypes.VIRTUAL,
    get() {
      //Reviso si tenemos productos
      if(this.commodities) {
        console.log('existen commodities en la orden')
      if (this.commodities.length > 0) {
        return this.commodities.reduce((total, commodity) => {
          return total + (commodity.price * commodity.PaymentWaste.amount);
        }, 0);
      }
      return 0;
    }
    }
  }
}


class Payment extends Model {

  static associate(models) {
    this.belongsTo(models.Recycler, {
      as: 'recycler',
    });
    this.belongsToMany(models.Waste, {
      as: 'commodities',
      through: models.PaymentWaste,
      foreignKey: 'paymentId',
      otherKey: 'wasteId'
    });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: PAYMENT_TABLE,
      modelName: 'Payment',
      timestamps: false
    }
  }
}

module.exports = { Payment, PaymentSchema, PAYMENT_TABLE };