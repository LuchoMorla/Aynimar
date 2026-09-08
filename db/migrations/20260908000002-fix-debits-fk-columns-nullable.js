'use strict';

/**
 * Corrige un schema drift contradictorio en `debits`:
 * `order_id` y `customer_id` se crearon como `allowNull: false` PERO con
 * `onDelete: 'SET NULL'` (ver `20240302221124-NewSuperMigration.js` y
 * `20230510075640-debitM.js`). Es imposible de cumplir: al borrar una `order`
 * (o un `customer`) Postgres intenta poner la FK en NULL y choca con el
 * NOT NULL → **rechaza el DELETE de la orden**. Ese es el motivo real por el
 * que el botón "Eliminar orden" del dashboard fallaba con
 * "No se puede eliminar la orden" (el front traga el error 500).
 *
 * Esta migración alinea el esquema con el `onDelete: 'SET NULL'` ya declarado:
 * hace ambas columnas NULLABLE. No toca la constraint FK existente (por eso el
 * `changeColumn` NO incluye `references` — evita el bug de FK duplicada visto
 * en `20260907000004`).
 *
 * `debits` es la tabla legacy de pagos con tarjeta (Nuvei/Paymentez); el MVP
 * actual usa COD + Ayni-Créditos + DeUna. Sin backfill: la constraint NOT NULL
 * nunca permitió filas con NULL, no hay datos que ajustar.
 */

const { DataTypes } = require('sequelize');

const DEBIT_TABLE = 'debits';

module.exports = {
  async up(queryInterface) {
    await queryInterface.changeColumn(DEBIT_TABLE, 'order_id', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await queryInterface.changeColumn(DEBIT_TABLE, 'customer_id', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.changeColumn(DEBIT_TABLE, 'order_id', {
      type: DataTypes.INTEGER,
      allowNull: false,
    });
    await queryInterface.changeColumn(DEBIT_TABLE, 'customer_id', {
      type: DataTypes.INTEGER,
      allowNull: false,
    });
  },
};
