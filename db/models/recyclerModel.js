const { Model, DataTypes, Sequelize } = require('sequelize');

const { USER_TABLE } = require('./userModel');

const RECYCLER_TABLE = 'recyclers';

const RecyclerSchema = {
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
    type: DataTypes.INTEGER,
    field: 'identity_number',
  },
  phone: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  phoneTwo: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'phone_two',
  },
  province: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  city: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'city',
  },
  postalCode: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'postal_code',
  },
  paymentType: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'payment_type'       
  },
  bank: {
    allowNull: true,
    type: DataTypes.STRING,
  },
  typeCount: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'type_count',
  },
  countNumber: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'count_number',
  },
  paymentDate: {
    allowNull: true,
    type: DataTypes.DATE,
    field: 'payment_date',
  },
  stateOfThePayment: {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'state_of_the_payment',
    defaultValue: 'revision',
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
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

class Recycler extends Model {
  static associate(models) {
    this.belongsTo(models.User, { as: 'user' }),
      this.hasMany(models.Payment, {
        as: 'payments',
        foreignKey: 'recyclerId',
      }),
      this.hasOne(models.Wallet, {
        as: 'wallet',
        foreignKey: 'recyclerId',
      });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: RECYCLER_TABLE,
      modelName: 'Recycler',
      timestamps: false,
    };
  }
}

module.exports = { Recycler, RecyclerSchema, RECYCLER_TABLE };
