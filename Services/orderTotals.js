'use strict';

/**
 * Política de totales/IVA y de transiciones de estado de una orden.
 *
 * Módulo puro (sin DB, sin red) para poder testearlo en scripts/smoke-test.js
 * sin levantar Sequelize.
 *
 * ⚠️  IVA — DECISIÓN DE NEGOCIO PENDIENTE. Ver docs/PAYMENTS.md §IVA.
 *   El dashboard llama a products.price "PVP" (IVA incluido, convención Ecuador);
 *   el checkout de la tienda lo trata como pre-IVA (+15%). No se puede confirmar
 *   desde el proyecto. Hasta que negocio lo confirme: tax=0, total=subtotal.
 *   Cuando se resuelva, este es el ÚNICO archivo del backend a tocar.
 */

/** Redondeo monetario a 2 decimales, robusto ante deriva de float. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * @param {Array<{price:number|string, qty:number|string}>} lineItems
 * @returns {{ subtotal:number, tax:number, total:number }}
 */
function computeOrderTotals(lineItems) {
  let subtotal = 0;
  for (const li of lineItems || []) {
    subtotal += Number(li.price) * Number(li.qty);
  }
  subtotal = round2(subtotal);
  const tax = 0; // ← pendiente decisión de negocio (ver arriba)
  const total = round2(subtotal + tax);
  return { subtotal, tax, total };
}

// Estados de fulfillment terminales: una vez ahí, sólo un admin los revierte.
const TERMINAL_STATE_ORDERS = [
  'entregado',
  'cancelado',
  'devuelto',
  'controversia_resuelta',
];

function isTerminalStateOrder(stateOrder) {
  return TERMINAL_STATE_ORDERS.includes(stateOrder);
}

module.exports = {
  round2,
  computeOrderTotals,
  TERMINAL_STATE_ORDERS,
  isTerminalStateOrder,
};
