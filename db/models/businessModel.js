const { Model, DataTypes, Sequelize } = require('sequelize');
const { BUSINESS_OWNER } = require('./businessOwnerModel');

const BUSINESS_TABLE = 'business';

const BusinessSchema = {
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
  name: {
    allowNull: false,
    type: DataTypes.STRING,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  ownerId: {
    field: 'business_owner_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: BUSINESS_OWNER,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  wooConsumerKey: {
    field:     'woo_consumer_key',
    type:      DataTypes.STRING(255),
    allowNull: true,
  },
  wooConsumerSecret: {
    field:     'woo_consumer_secret',
    type:      DataTypes.TEXT,
    allowNull: true,
  },
}


class Business extends Model {

  static associate(models) {
    this.hasMany(models.Product, {
      as: 'products',
      foreignKey: "business_id",
    });
    this.hasMany(models.Waste, {
      as: 'wastes',
      foreignKey: "business_id",
    });
    this.belongsTo(models.BusinessOwner, {
      as: 'businessOwner',
      foreignKey: "business_owner_id"
    });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: BUSINESS_TABLE,
      modelName: 'Business',
      timestamps: false
    }
  }
}

module.exports = { Business, BusinessSchema, BUSINESS_TABLE };
