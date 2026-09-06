'use strict';

/**
 * Catalog Pricing Service — integración progresiva del Pricing Engine con el
 * catálogo (plan acordado en conversación, sin archivo de spec separado).
 *
 * Puro, sin efectos secundarios. NO importa routers, NO importa
 * db/models/productModel ni ningún otro modelo Sequelize, NO hace
 * `product.update()`, NO escribe en PostgreSQL, NO modifica `product.price`
 * ni `product.costPrice`, NO toca Dropi, Effi, checkout, orderService ni
 * woocommerceMirror.js. Recibe datos YA EXTRAÍDOS (costPrice, quantity,
 * taxRate, ...) — nunca lee un producto de la base de datos. Delega el
 * cálculo económico íntegramente a Services/pricingEngine.js (Cost/Pricing/
 * Commercial Engine + etapa de presentación) y Services/orderTotals.js (Tax
 * Engine, solo para el default de `taxRate`) — no reimplementa ninguna
 * fórmula propia.
 *
 * Política de costo desconocido (autorizada explícitamente para este
 * archivo): un costo desconocido NUNCA se convierte en 0. `costPrice=0` se
 * trata como dato SOSPECHOSO para un producto comercial, no como costo
 * válido, salvo que el caller pase `allowZeroCost:true` explícitamente (caso
 * de contexto real, ej. producto genuinamente gratuito — mismo espíritu que
 * la excepción de piso económico ya existente en pricingEngine.js).
 */

const {
  computePricingResult,
  computeCommercialPrice,
  computeFinalGrossPrice,
  PRODUCT_COST_KEY,
} = require('./pricingEngine');
const { TAX_RATE } = require('./orderTotals');

/**
 * Clasifica un `costPrice` crudo (tal como podría venir de
 * `product.costPrice`, YA EXTRAÍDO por el caller) según la política de este
 * servicio. No lee nada de la base de datos — es una función pura sobre el
 * valor recibido.
 *
 * @param {*} costPrice
 * @returns {'unknown'|'invalid'|'suspicious'|'valid'}
 *   'unknown'    — null/undefined/no numérico/NaN/Infinity. Costo desconocido, nunca tratado como 0.
 *   'invalid'    — numérico pero negativo. Un costo nunca es negativo.
 *   'suspicious' — exactamente 0. Posible dato incompleto para un producto comercial, no un costo normal.
 *   'valid'      — numérico, finito, > 0.
 */
function classifyCostPrice(costPrice) {
  if (costPrice === null || costPrice === undefined) return 'unknown';
  if (typeof costPrice !== 'number' || !Number.isFinite(costPrice)) return 'unknown';
  if (costPrice < 0) return 'invalid';
  if (costPrice === 0) return 'suspicious';
  return 'valid';
}

/**
 * Calcula un PVP candidato para UN producto a partir de datos ya extraídos.
 * Nunca lee `product.price`/`product.costPrice` de la base de datos, nunca
 * escribe nada — el caller decide qué hacer con el resultado.
 *
 * @param {Object} input
 * @param {number|null|undefined} input.costPrice  Costo puro del producto, YA EXTRAÍDO.
 * @param {number} [input.quantity=1]
 * @param {number} [input.taxRate]  Default: TAX_RATE de orderTotals.js (única fuente de la tasa).
 * @param {number} input.targetContributionMargin
 * @param {string} [input.strategyName='EXACT']
 * @param {boolean} [input.allowZeroCost=false]  Excepción explícita para tratar costPrice=0 como válido.
 * @param {number} [input.manualNetPrice]     Pass-through a computeCommercialPrice().
 * @param {string} [input.rationale]          Pass-through a computeCommercialPrice().
 * @param {number} [input.referencePrice]     Pass-through a computeCommercialPrice().
 * @param {boolean} [input.allowBelowFloor]   Pass-through a computeCommercialPrice().
 * @param {string} [input.overrideReason]     Pass-through a computeCommercialPrice().
 * @returns {{
 *   status: 'OK'|'INCOMPLETE_COST_DATA'|'INVALID_COST_DATA',
 *   reason: string|null,
 *   costPrice: number|null,
 *   costPriceClassification: 'unknown'|'invalid'|'suspicious'|'valid',
 *   pricing: Object|null,
 *   commercial: Object|null,
 *   final: Object|null,
 * }}
 */
function calculateCatalogPrice({
  costPrice,
  quantity = 1,
  taxRate = TAX_RATE,
  targetContributionMargin,
  strategyName = 'EXACT',
  allowZeroCost = false,
  manualNetPrice,
  rationale,
  referencePrice,
  allowBelowFloor,
  overrideReason,
} = {}) {
  const costPriceClassification = classifyCostPrice(costPrice);

  if (costPriceClassification === 'invalid') {
    return {
      status: 'INVALID_COST_DATA',
      reason: `costPrice negativo (${JSON.stringify(costPrice)}) — un costo nunca puede ser negativo.`,
      costPrice, costPriceClassification,
      pricing: null, commercial: null, final: null,
    };
  }

  if (costPriceClassification === 'unknown') {
    return {
      status: 'INCOMPLETE_COST_DATA',
      reason: `costPrice ausente o no numérico (${JSON.stringify(costPrice)}) — el motor nunca inventa un costo desconocido; no se calcula ningún PVP.`,
      costPrice: null, costPriceClassification,
      pricing: null, commercial: null, final: null,
    };
  }

  if (costPriceClassification === 'suspicious' && allowZeroCost !== true) {
    return {
      status: 'INCOMPLETE_COST_DATA',
      reason: 'costPrice = 0 tratado como dato sospechoso/incompleto para un producto comercial, no como costo real — ' +
        'pasa allowZeroCost:true explícitamente solo si el costo cero es intencional (ej. producto genuinamente gratuito).',
      costPrice, costPriceClassification,
      pricing: null, commercial: null, final: null,
    };
  }

  // A partir de aquí: costPrice es 'valid', o 'suspicious' con allowZeroCost=true explícito.
  const costComponents = [{
    key: PRODUCT_COST_KEY,
    kind: 'absolute',
    scope: 'per_unit',
    status: 'known',
    value: costPrice,
    source: 'catalog.costPrice',
  }];

  const pricing = computePricingResult({ quantity, taxRate, targetContributionMargin, costComponents });
  const commercial = computeCommercialPrice({
    pricingResult: pricing, manualNetPrice, strategyName, rationale, referencePrice, allowBelowFloor, overrideReason,
  });
  const final = computeFinalGrossPrice({ commercialResult: commercial, taxRate, strategyName });

  return {
    status: 'OK',
    reason: null,
    costPrice, costPriceClassification,
    pricing, commercial, final,
  };
}

module.exports = { calculateCatalogPrice, classifyCostPrice };
