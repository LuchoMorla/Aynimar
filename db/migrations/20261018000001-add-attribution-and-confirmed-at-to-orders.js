'use strict';

/**
 * Atribución de pedidos (UTM / click ids) + fecha real de compra.
 *
 * Columnas nuevas, ambas NULLABLE y aditivas — ninguna fila existente se toca:
 *
 *  - attribution  JSONB nullable — último toque capturado por la tienda
 *      (utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
 *      ttclid, referrer, landing_path, first_seen_at). Validado con Joi en
 *      schemaODtos/orderSchema.js (attributionSchema). NULL = sin datos.
 *  - confirmed_at TIMESTAMP nullable — cuándo el cliente confirmó la compra
 *      (sale de 'carrito' vía checkout() o confirm-cod). `created_at` es la
 *      creación del CARRITO, no de la compra.
 *
 * SIN BACKFILL: las órdenes previas quedan con NULL (= "no registrado"); no
 * se infiere confirmed_at desde created_at.
 */

const { ORDER_TABLE } = require('../models/orderModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(ORDER_TABLE, 'attribution', {
      type: Sequelize.DataTypes.JSONB,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn(ORDER_TABLE, 'confirmed_at', {
      type: Sequelize.DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(ORDER_TABLE, 'confirmed_at');
    await queryInterface.removeColumn(ORDER_TABLE, 'attribution');
  },
};
