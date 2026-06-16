'use strict';

const { Model, DataTypes } = require('sequelize');

const SALES_PERFORMANCE_TABLE = 'sales_performance';

const SalesPerformanceSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  sessionId: {
    field: 'session_id',
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  outcome: {
    type: DataTypes.STRING(32),
    allowNull: false,
  },
  productIds: {
    field: 'product_ids',
    type: DataTypes.JSONB,
    allowNull: true,
  },
  cartValue: {
    field: 'cart_value',
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  turns: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  lastIntent: {
    field: 'last_intent',
    type: DataTypes.TEXT,
    allowNull: true,
  },
  toolCalls: {
    field: 'tool_calls',
    type: DataTypes.JSONB,
    allowNull: true,
  },
  createdAt: {
    field: 'created_at',
    allowNull: false,
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
};

class SalesPerformance extends Model {
  static associate() {}

  static config(sequelize) {
    return {
      sequelize,
      tableName: SALES_PERFORMANCE_TABLE,
      modelName: 'SalesPerformance',
      timestamps: false,
    };
  }
}

module.exports = { SALES_PERFORMANCE_TABLE, SalesPerformance, SalesPerformanceSchema };
