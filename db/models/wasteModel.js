const { Model, DataTypes, Sequelize } = require('sequelize');

const { WASTE_CATEGORY_TABLE } = require('./wasteCategoryModel');
const { BUSINESS_TABLE } = require('./businessModel');

const WASTE_TABLE = 'wastes';

const WasteSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  price: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  wasteCategoryId: {
    field: 'waste_category_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: WASTE_CATEGORY_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  businessId: {
    field: 'business_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: {
      model: BUSINESS_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  }
}


class Waste extends Model {

  static associate(models) {
    this.belongsTo(models.Business, { as: 'business' });
    this.belongsTo(models.WasteCategory, { as: 'waste_category' });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: WASTE_TABLE,
      modelName: 'Waste',
      timestamps: false
    }
  }
}

module.exports = { Waste, WasteSchema, WASTE_TABLE };
