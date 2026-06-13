'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');

const { PRODUCT_TABLE } = require('./productModel');
const { BUSINESS_TABLE } = require('./businessModel');

const REVIEW_TABLE = 'reviews';

const ReviewSchema = {
  id: {
    allowNull:     false,
    autoIncrement: true,
    primaryKey:    true,
    type:          DataTypes.INTEGER,
  },
  productId: {
    field:      'product_id',
    allowNull:  false,
    type:       DataTypes.INTEGER,
    references: { model: PRODUCT_TABLE, key: 'id' },
    onUpdate:   'CASCADE',
    onDelete:   'CASCADE',
  },
  businessId: {
    field:      'business_id',
    allowNull:  true,
    type:       DataTypes.INTEGER,
    references: { model: BUSINESS_TABLE, key: 'id' },
    onUpdate:   'CASCADE',
    onDelete:   'SET NULL',
  },
  rating: {
    allowNull: false,
    type:      DataTypes.INTEGER,
  },
  customerName: {
    field:     'customer_name',
    allowNull: false,
    type:      DataTypes.STRING,
  },
  city: {
    allowNull: true,
    type:      DataTypes.STRING,
  },
  comment: {
    allowNull: false,
    type:      DataTypes.TEXT,
  },
  imagesJson: {
    field:     'images_json',
    allowNull: true,
    type:      DataTypes.TEXT,
  },
  createdAt: {
    field:        'created_at',
    allowNull:    false,
    type:         DataTypes.DATE,
    defaultValue: Sequelize.NOW,
  },
};

class Review extends Model {
  static associate(models) {
    this.belongsTo(models.Product,  { as: 'product',  foreignKey: 'product_id' });
    this.belongsTo(models.Business, { as: 'business', foreignKey: 'business_id' });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName:  REVIEW_TABLE,
      modelName:  'Review',
      timestamps: false,
    };
  }
}

module.exports = { Review, ReviewSchema, REVIEW_TABLE };
