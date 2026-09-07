'use strict';

/**
 * Corrige otro schema drift descubierto al validar `checkout()` contra
 * Postgres real: `orders.payment_method` se creó como `allowNull: false`
 * (`20250618150857-pago-contra-entrega.js`), pero el diseño actual del
 * checkout (`Services/orderService.js::checkout()`) escribe explícitamente
 * `paymentMethod: null` cuando la orden no se cubre con créditos (caso normal
 * de DeUna: queda un saldo externo por pagar, sin método aún confirmado).
 *
 * El modelo (`db/models/orderModel.js`) ya declara
 * `paymentMethod: { allowNull: true }` — esta migración alinea la BD real
 * con ese diseño ya existente. Verificado (grep) que ningún otro código lee
 * `order.paymentMethod` asumiendo que nunca es null.
 *
 * No se toca el `defaultValue: 'contra_entrega'` de la columna: sigue
 * aplicándose quando el INSERT omite la columna (creación de orden nueva,
 * sin especificar método de pago aún) — allowNull:true no afecta el default,
 * solo permite que una escritura EXPLÍCITA de NULL sea válida.
 */

const { ORDER_TABLE } = require('../models/orderModel');
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    await queryInterface.changeColumn(ORDER_TABLE, 'payment_method', {
      allowNull: true,
      type: DataTypes.STRING,
      defaultValue: 'contra_entrega',
    });
  },

  async down(queryInterface) {
    await queryInterface.changeColumn(ORDER_TABLE, 'payment_method', {
      allowNull: false,
      type: DataTypes.STRING,
      defaultValue: 'contra_entrega',
    });
  },
};
