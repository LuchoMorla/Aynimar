'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');

// Encargos del dueño al CTO/CEO (migración 20261023000001-create-telegram-ops-requests).
const TELEGRAM_OPS_REQUEST_TABLE = 'telegram_ops_requests';

const TelegramOpsRequestSchema = {
  id:         { allowNull: false, autoIncrement: true, primaryKey: true, type: DataTypes.INTEGER },
  requestId:  { field: 'request_id', allowNull: false, unique: true, type: DataTypes.STRING(64) },
  recipient:  { allowNull: false, type: DataTypes.STRING(8), validate: { isIn: [['cto', 'ceo']] } },
  body:       { allowNull: false, type: DataTypes.TEXT },
  status:     { allowNull: false, type: DataTypes.STRING(12), defaultValue: 'nueva', validate: { isIn: [['nueva', 'en_curso', 'respondida']] } },
  createdAt:  { field: 'created_at', allowNull: false, type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  takenAt:    { field: 'taken_at', type: DataTypes.DATE },
  answeredAt: { field: 'answered_at', type: DataTypes.DATE },
  answer:     { type: DataTypes.TEXT },
};

class TelegramOpsRequest extends Model {
  static associate() {}

  static config(sequelize) {
    return { sequelize, tableName: TELEGRAM_OPS_REQUEST_TABLE, modelName: 'TelegramOpsRequest', timestamps: false };
  }
}

module.exports = { TelegramOpsRequest, TelegramOpsRequestSchema, TELEGRAM_OPS_REQUEST_TABLE };
