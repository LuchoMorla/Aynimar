'use strict';

/**
 * Corrige un schema drift: `orders.customer_id` se creó como `allowNull: false`
 * en la migración original (`20220727092613-first-migration.js`), pero el
 * diseño de la aplicación siempre soportó órdenes SIN customer (carritos de
 * invitado — ver `Services/orderService.js::createGuestOrder()`, que crea
 * `Order.create({})` explícitamente sin `customerId`).
 *
 * El modelo Sequelize (`db/models/orderModel.js`) ya declara
 * `customerId: { allowNull: true, onDelete: 'SET NULL' }` — esta migración
 * alinea el esquema real de la BD con un diseño ya existente, no introduce
 * un comportamiento nuevo.
 *
 * Sin backfill: la constraint NOT NULL real nunca permitió filas con
 * customer_id NULL, así que no hay datos existentes que requieran ajuste.
 */

const { ORDER_TABLE } = require('../models/orderModel');
const { CUSTOMER_TABLE } = require('../models/customerModel');
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    await queryInterface.changeColumn(ORDER_TABLE, 'customer_id', {
      allowNull: true,
      type: DataTypes.INTEGER,
      references: {
        model: CUSTOMER_TABLE,
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.changeColumn(ORDER_TABLE, 'customer_id', {
      allowNull: false,
      type: DataTypes.INTEGER,
      references: {
        model: CUSTOMER_TABLE,
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },
};
