'use strict';

/**
 * Política de totales/IVA y de transiciones de estado de una orden.
 *
 * Módulo puro (sin DB, sin red) para poder testearlo en scripts/smoke-test.js
 * sin levantar Sequelize.
 *
 * IVA — RESUELTO (2026-09-06). Aynimar S.A.S. es RIMPE Emprendedor → cobra
 * IVA. Tarifa vigente SRI: 15%. Convención única de todo el sistema:
 *
 *   product.price = PVP final que paga el cliente, IVA INCLUIDO.
 *
 * El IVA nunca se suma hacia adelante (nunca `precio × 1.15`) — ya está
 * contenido en `product.price`/`subtotal`. Se extrae hacia atrás solo para
 * el desglose informativo/tributario:
 *
 *   base_imponible = PVP / (1 + TAX_RATE)
 *   tax            = PVP − base_imponible
 *
 * El IVA no es utilidad ni se resta del monto a cobrar — `tax` es puramente
 * informativo. Los créditos/descuentos se restan directamente del `subtotal`
 * (que ya incluye IVA): no hay que volver a calcular impuesto sobre el saldo.
 *
 * Este es el ÚNICO archivo del backend que conoce `TAX_RATE`.
 */

/** Tarifa general de IVA vigente (SRI Ecuador, 2026). Único lugar del backend. */
const TAX_RATE = 0.15;

/** Redondeo monetario a 2 decimales, robusto ante deriva de float. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * @param {Array<{price:number|string, qty:number|string}>} lineItems  price = PVP unitario, IVA incluido.
 * @returns {{ subtotal:number, tax:number, total:number }}
 *   subtotal — suma de PVP × qty (ya incluye IVA).
 *   tax      — IVA contenido en `subtotal`, extraído hacia atrás. Informativo únicamente.
 *   total    — monto bruto adeudado antes de créditos/descuentos (== subtotal).
 */
function computeOrderTotals(lineItems) {
  let subtotal = 0;
  for (const li of lineItems || []) {
    subtotal += Number(li.price) * Number(li.qty);
  }
  subtotal = round2(subtotal);
  const base = round2(subtotal / (1 + TAX_RATE));
  const tax = round2(subtotal - base); // subtotal = base + tax, exacto
  const total = subtotal;
  return { subtotal, tax, total };
}

/**
 * Tax Engine — conversión NETO → BRUTO/PVP (spec docs/PRICING_ENGINE_SPEC.md,
 * sección B.4; Pricing Engine — Paso 4).
 *
 * Responsabilidad EXCLUSIVA: aplicar `taxRate`. No decide margen, markup,
 * piso económico, estrategia comercial, descuentos ni redondeo de
 * presentación — esas responsabilidades viven en Services/pricingEngine.js
 * (Cost/Pricing/Commercial Engine), que CONSUME estas funciones, nunca las
 * reimplementa. Esta es la única fuente de verdad de la lógica fiscal del
 * sistema — `computeOrderTotals()` (arriba, checkout) no se modifica ni se
 * refactoriza para usar esto: es la misma fórmula, deliberadamente no tocada
 * para no introducir riesgo de regresión en un camino ya validado en
 * producción (Fase A/B). Ver informe del Paso 4 para la justificación
 * explícita de esta decisión.
 *
 * @param {number} netPrice  Precio neto, sin IVA.
 * @param {number} taxRate   Parámetro explícito — NUNCA hardcodeado aquí. El
 *   caller pasa `TAX_RATE` (exportado por este mismo archivo) u otra tasa
 *   válida (ej. 0 para un régimen que no cobra IVA).
 * @returns {{netPrice:number, taxRate:number, taxAmount:number, grossPrice:number}}
 */
function toGross(netPrice, taxRate) {
  if (typeof netPrice !== 'number' || !Number.isFinite(netPrice) || netPrice < 0) {
    throw new Error(`toGross: netPrice debe ser un número finito >= 0 (recibido: ${JSON.stringify(netPrice)}).`);
  }
  if (typeof taxRate !== 'number' || !Number.isFinite(taxRate) || taxRate < 0) {
    throw new Error(`toGross: taxRate debe ser un número finito >= 0 (recibido: ${JSON.stringify(taxRate)}).`);
  }
  const grossPrice = round2(netPrice * (1 + taxRate));
  // taxAmount como residuo exacto (grossPrice − netPrice), NUNCA
  // round2(netPrice×taxRate) calculado por separado — mismo principio que
  // computeOrderTotals: netPrice + taxAmount === grossPrice siempre, sin
  // fuga de centavos entre los tres valores.
  const taxAmount = round2(grossPrice - netPrice);
  return { netPrice, taxRate, taxAmount, grossPrice };
}

/**
 * Tax Engine — conversión BRUTO/PVP → NETO (dirección inversa de `toGross`).
 * Misma responsabilidad exclusiva, mismo principio de residuo exacto.
 *
 * @param {number} grossPrice  Precio con IVA incluido (PVP).
 * @param {number} taxRate     Parámetro explícito — nunca hardcodeado.
 * @returns {{grossPrice:number, taxRate:number, base:number, taxAmount:number}}
 */
function extractFromGross(grossPrice, taxRate) {
  if (typeof grossPrice !== 'number' || !Number.isFinite(grossPrice) || grossPrice < 0) {
    throw new Error(`extractFromGross: grossPrice debe ser un número finito >= 0 (recibido: ${JSON.stringify(grossPrice)}).`);
  }
  if (typeof taxRate !== 'number' || !Number.isFinite(taxRate) || taxRate < 0) {
    throw new Error(`extractFromGross: taxRate debe ser un número finito >= 0 (recibido: ${JSON.stringify(taxRate)}).`);
  }
  const base = round2(grossPrice / (1 + taxRate));
  const taxAmount = round2(grossPrice - base);
  return { grossPrice, taxRate, base, taxAmount };
}

/**
 * Aplica Ayni-Créditos (descuento, no un segundo cobro) sobre un `subtotal`
 * que ya incluye IVA. El crédito reduce directamente el monto a pagar — no
 * se vuelve a calcular impuesto sobre el saldo resultante.
 *
 * @param {number} subtotal        PVP-inclusive, ya calculado por computeOrderTotals.
 * @param {number} creditsToApply  Créditos solicitados (enteros, 1 crédito = $1).
 * @returns {{ creditsUsed:number, amountToPay:number }}
 */
function computeCreditRedemption(subtotal, creditsToApply) {
  const maxCredits = Math.max(0, Math.floor(Number(subtotal) || 0));
  const requested = Math.trunc(Number(creditsToApply) || 0);
  const creditsUsed = Math.min(Math.max(0, requested), maxCredits);
  const amountToPay = round2(Math.max(0, Number(subtotal) - creditsUsed));
  return { creditsUsed, amountToPay };
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
  TAX_RATE,
  round2,
  computeOrderTotals,
  toGross,
  extractFromGross,
  computeCreditRedemption,
  TERMINAL_STATE_ORDERS,
  isTerminalStateOrder,
};
