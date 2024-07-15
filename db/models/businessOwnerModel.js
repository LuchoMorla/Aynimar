const { Model, DataTypes } = require('sequelize');

const { USER_TABLE } = require('./userModel');

const BUSINESS_OWNER = 'bussiness_owner';

const BussinesOwnerSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  name: {
    allowNull: false,
    type: DataTypes.STRING,
  },
  lastName: {
    allowNull: false,
    type: DataTypes.STRING,
    field: 'last_name',
  },
  identityNumber: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'identity_number',
  },
  userId: {
    field: 'user_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    unique: true,
    references: {
      model: USER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
};

class BusinessOwner extends Model {
  static associate(models) {
    this.belongsTo(models.User, { as: 'user' });
    this.hasMany(models.Business, { as: "business", foreignKey: "business_owner_id" });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: BUSINESS_OWNER,
      modelName: 'BusinessOwner',
      timestamps: false,
    };
  }
}

module.exports = { BusinessOwner, BussinesOwnerSchema, BUSINESS_OWNER };
