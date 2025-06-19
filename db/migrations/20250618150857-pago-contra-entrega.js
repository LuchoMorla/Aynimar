'use strict';

const { ORDER_TABLE } = require('../models/orderModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(ORDER_TABLE, 'payment_method', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'contra_entrega', // opción por defecto, tarjeta de credito
    });

    await queryInterface.addColumn(ORDER_TABLE, 'status', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'pendiente', // otras opciones: 'pagado', 'enviado', 'cancelado'
    });

    await queryInterface.addColumn(ORDER_TABLE, 'total', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn(ORDER_TABLE, 'payment_method');
    await queryInterface.removeColumn(ORDER_TABLE, 'status');
    await queryInterface.removeColumn(ORDER_TABLE, 'total');
  }
};
