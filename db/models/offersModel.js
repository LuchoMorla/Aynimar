const { Model, DataTypes, Sequelize } = require('sequelize');
const { PAYMENT_TABLE } = require('./paymentModel');
const OFFER_TABLE = 'offers';

const OfferSchema = {
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

  status: {
    allowNull: false,
    type: DataTypes.STRING,
    defaultValue: 'pending'
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
  }
};

class Offer extends Model {
  static associate(models) {
    this.belongsTo(models.Payment, {
      foreignKey: "paymentId",
      as: 'payment'
    });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: OFFER_TABLE,
      modelName: 'Offers',
      timestamps: false
    };
  }
}

module.exports = { Offer, OfferSchema, OFFER_TABLE };
