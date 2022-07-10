const { Model, DataTypes, Sequelize } = require('sequelize');

const WASTE_CATEGORY_TABLE = 'waste_categories';

const WasteCategorySchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  name: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
}


class WasteCategory extends Model {

  static associate(models) {
    this.hasMany(models.Waste, {
      as: 'wastes',
      foreignKey: 'wasteCategoryId'
    });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: WASTE_CATEGORY_TABLE,
      modelName: 'WasteCategory',
      timestamps: false
    }
  }
}

module.exports = { WasteCategory, WasteCategorySchema, WASTE_CATEGORY_TABLE };
