'use strict';

const { RECYCLER_TABLE } = require("../models/recyclerModel");
const { CUSTOMER_TABLE } = require("../models/customerModel");
const { DataTypes, Sequelize } = require('sequelize');
/* const { RecyclerSchema } = require("../models/recyclerModel");
 */
module.exports = {
  async up (queryInterface, Sequelize) {
   await queryInterface.changeColumn(RECYCLER_TABLE, 'city', {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'city',
  }
/*   await queryInterface.addColumn(RECYCLER_TABLE, 'phone_two', {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'phone_two'
  }),
  await queryInterface.addColumn(RECYCLER_TABLE, 'province', {
    allowNull: true,
    type: DataTypes.STRING,
  }),
  await queryInterface.addColumn(RECYCLER_TABLE, 'postal_code', {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'postal_code'
  }), */
/*   await queryInterface.changeColumn(RECYCLER_TABLE, RecyclerSchema.paymentType, {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'payment_type'
  }), */
/*   await queryInterface.addColumn(CUSTOMER_TABLE, 'identity_number', {
    allowNull: true,
    type:DataTypes.INTEGER,
    field: 'identity_number',
  }),   */
/*   await queryInterface.addColumn(CUSTOMER_TABLE, 'phone_two', {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'phone_two'
  }),
  await queryInterface.addColumn(CUSTOMER_TABLE, 'province', {
    allowNull: true,
    type: DataTypes.STRING,
  }),
  await queryInterface.addColumn(CUSTOMER_TABLE, 'city', {
    allowNull: true,
    type: DataTypes.STRING
  }),
  await queryInterface.addColumn(CUSTOMER_TABLE, 'postal_code', {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'postal_code'
  }),
  await queryInterface.changeColumn(RECYCLER_TABLE, 'identity_number', {
    allowNull: true,
    type:DataTypes.INTEGER,
    field: 'identity_number',
  }) */
  );
  },

  async down (queryInterface, Sequelize) {
  await queryInterface.changeColumn(RECYCLER_TABLE, 'city', {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'payment_city',
  })/* ,
  await queryInterface.removeColumn(RECYCLER_TABLE, 'phone_two'),
  await queryInterface.removeColumn(RECYCLER_TABLE, 'province'),
  await queryInterface.removeColumn(RECYCLER_TABLE, 'postal_code'), */
/*   await queryInterface.removeColumn(RECYCLER_TABLE, RecyclerSchema.paymentType, {
    allowNull: true,
    type: DataTypes.STRING,
    field: 'paymentType',
  }) ,*/
/*   await queryInterface.removeColumn(CUSTOMER_TABLE, 'identity_number'), */
/*   await queryInterface.removeColumn(CUSTOMER_TABLE, 'phone_two'),
  await queryInterface.removeColumn(CUSTOMER_TABLE, 'province'),
  await queryInterface.removeColumn(CUSTOMER_TABLE, 'city'),
  await queryInterface.removeColumn(CUSTOMER_TABLE, 'postal_code') */
/*   await queryInterface.changeColumn(RECYCLER_TABLE, 'identity_number', {
    allowNull: false,
    type: DataTypes.STRING,
    field: 'paymentType',
  }) */
}
};
