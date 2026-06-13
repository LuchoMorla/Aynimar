'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');

const APP_SETTING_TABLE = 'app_settings';

const AppSettingSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  key: {
    allowNull: false,
    unique: true,
    type: DataTypes.STRING(100),
  },
  value: {
    allowNull: true,
    type: DataTypes.TEXT,
  },
  updatedAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'updated_at',
    defaultValue: Sequelize.NOW,
  },
};

class AppSetting extends Model {
  static associate() {}

  static config(sequelize) {
    return {
      sequelize,
      tableName: APP_SETTING_TABLE,
      modelName: 'AppSetting',
      timestamps: false,
    };
  }
}

module.exports = { AppSetting, AppSettingSchema, APP_SETTING_TABLE };
