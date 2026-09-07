'use strict';

const { DataTypes } = require('sequelize');
const { ORDER_PRODUCT_TABLE } = require('../models/order-productModel');

module.exports = {
  async up(queryInterface) {
    // NOTA (reparación cadena de migraciones): estas dos llamadas se ejecutaban
    // sin `await`, así que `up()` resolvía antes de que los ALTER terminaran.
    // Sequelize-cli marcaba la migración como aplicada de forma no determinista
    // (a veces las columnas no llegaban a cambiar). Se añade `await` — el efecto
    // pretendido no cambia. No re-ejecuta en BD que ya la tiene registrada.
    await queryInterface.changeColumn(ORDER_PRODUCT_TABLE, 'order_id', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await queryInterface.changeColumn(ORDER_PRODUCT_TABLE, 'product_id', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  },

  async down() {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
  },
};
