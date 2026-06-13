'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');
const { BUSINESS_TABLE } = require('./businessModel');

const COUPON_TABLE = 'coupons';

const CouponSchema = {
  id: {
    allowNull:     false,
    autoIncrement: true,
    primaryKey:    true,
    type:          DataTypes.INTEGER,
  },
  businessId: {
    field:      'business_id',
    allowNull:  false,
    type:       DataTypes.INTEGER,
    references: { model: BUSINESS_TABLE, key: 'id' },
    onUpdate:   'CASCADE',
    onDelete:   'CASCADE',
  },
  code: {
    allowNull: false,
    type:      DataTypes.STRING(50),
  },
  type: {
    allowNull: false,
    type:      DataTypes.ENUM('PERCENTAGE', 'FIXED_AMOUNT'),
  },
  value: {
    allowNull: false,
    type:      DataTypes.DECIMAL(10, 2),
  },
  minOrderAmount: {
    field:        'min_order_amount',
    allowNull:    true,
    type:         DataTypes.DECIMAL(10, 2),
    defaultValue: null,
  },
  startDate: {
    field:        'start_date',
    allowNull:    true,
    type:         DataTypes.DATEONLY,
    defaultValue: null,
  },
  endDate: {
    field:        'end_date',
    allowNull:    true,
    type:         DataTypes.DATEONLY,
    defaultValue: null,
  },
  isActive: {
    field:        'is_active',
    allowNull:    false,
    type:         DataTypes.BOOLEAN,
    defaultValue: true,
  },
  createdAt: {
    field:        'created_at',
    allowNull:    false,
    type:         DataTypes.DATE,
    defaultValue: Sequelize.NOW,
  },
};

class Coupon extends Model {
  static associate(models) {
    this.belongsTo(models.Business, { as: 'business', foreignKey: 'business_id' });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName:  COUPON_TABLE,
      modelName:  'Coupon',
      timestamps: false,
    };
  }
}

module.exports = { Coupon, CouponSchema, COUPON_TABLE };
