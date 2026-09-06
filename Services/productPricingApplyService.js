'use strict';

/**
 * Product Pricing Apply Service — Paso 10 (apply-engine).
 *
 * Única pieza del sistema autorizada a producir `pricingSource='engine'`.
 * Se limita estrictamente a: leer → invocar calculateCatalogPrice() → validar
 * resultado → verificar drift → persistir. NO reimplementa ninguna fórmula —
 * toda la matemática (costo/margen/piso/redondeo/IVA) sigue exclusivamente en
 * Services/catalogPricingService.js / Services/pricingEngine.js. El único
 * cálculo propio de este archivo es la comparación monetaria de
 * `expectedFinalGrossPrice`, que reutiliza `round2` de orderTotals.js — no
 * define su propio redondeo.
 *
 * `Services/pricingAuthority.js` (protección de sincronizaciones automáticas,
 * Paso 9) NO se usa aquí — este flujo es una acción humana explícita
 * (apply-engine), no un proceso automático; puede sobrescribir cualquier
 * pricingSource actual (manual/engine/legacy_sync/NULL → engine), siempre que
 * el resultado del cálculo sea económicamente válido.
 *
 * `allowBelowFloor`/`overrideReason` NO se aceptan como parámetros de este
 * servicio — no se pasan a calculateCatalogPrice(), por lo que
 * validateFloor() nunca puede devolver APPROVED_BELOW_FLOOR desde este
 * camino. El rechazo explícito por body inválido ocurre antes, a nivel de
 * schema Joi (routes/productosRouting.js + schemaODtos/productSchema.js).
 */

const { models } = require('../libs/sequelize');
const { calculateCatalogPrice } = require('./catalogPricingService');
const { round2 } = require('./orderTotals');

const APPLY_STATUS = {
  NOT_FOUND: 'NOT_FOUND',
  INCOMPLETE_COST_DATA: 'INCOMPLETE_COST_DATA',
  INVALID_COST_DATA: 'INVALID_COST_DATA',
  CALCULATION_INVALID: 'CALCULATION_INVALID',
  PRICE_DRIFTED: 'PRICE_DRIFTED',
  APPLIED: 'APPLIED',
};

/**
 * Convierte un valor monetario (number o string numérica) a centavos enteros,
 * usando el mismo redondeo canónico que el resto del sistema (round2 de
 * orderTotals.js) — nunca un redondeo propio.
 * @returns {number|null} null si el valor no es parseable como monto.
 */
function toCents(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.round(round2(n) * 100);
}

/**
 * Igualdad monetaria exacta al centavo, tolerante a number/string, intolerante
 * a cualquier diferencia real (nunca `a !== b` directo sobre DECIMAL/string/number).
 */
function monetaryEquals(a, b) {
  const centsA = toCents(a);
  const centsB = toCents(b);
  if (centsA === null || centsB === null) return false;
  return centsA === centsB;
}

/**
 * Ejecuta el cálculo del motor sobre un producto YA LEÍDO (nunca vuelve a
 * consultar la base de datos) — pieza compartida entre preview y apply, para
 * que ninguna de las dos funciones tenga que leer el producto más de una vez.
 * quantity queda fija en 1 — bundles no están conectados al catálogo todavía.
 */
function computeResultForProduct(product, params) {
  return calculateCatalogPrice({
    costPrice: product.costPrice,
    quantity: 1,
    targetContributionMargin: params.targetContributionMargin,
    strategyName: params.strategyName,
    allowZeroCost: params.allowZeroCost,
    manualNetPrice: params.manualNetPrice,
    rationale: params.rationale,
    referencePrice: params.referencePrice,
    // allowBelowFloor / overrideReason deliberadamente NUNCA se pasan aquí.
  });
}

/**
 * Preview — 100% read-only. Una sola lectura, ningún `.update()`.
 * @returns {Promise<{notFound:boolean, result:Object|null}>}
 */
async function previewEnginePrice(productId, params = {}) {
  const product = await models.Product.findByPk(productId);
  if (!product) {
    return { notFound: true, result: null };
  }
  const result = computeResultForProduct(product, params);
  return { notFound: false, result };
}

/**
 * Apply-engine — única función que puede escribir pricingSource='engine'.
 * Exactamente UNA lectura de producto (`findByPk`), reutilizada tanto para
 * calcular como para el `.update()` final — sin segunda lectura, para no
 * ampliar la ventana de carrera (ver informe de diseño Paso 10, §10).
 *
 * @param {number|string} productId
 * @param {Object} params  Mismo shape que previewEnginePrice, más:
 * @param {number} [params.expectedFinalGrossPrice]  Protección anti-drift.
 * @returns {Promise<{notFound:boolean, applied:boolean, status:string, result:Object|null}>}
 */
async function applyEnginePrice(productId, params = {}) {
  const product = await models.Product.findByPk(productId); // ÚNICA lectura
  if (!product) {
    return { notFound: true, applied: false, status: APPLY_STATUS.NOT_FOUND, result: null };
  }

  const result = computeResultForProduct(product, params);

  if (result.status !== 'OK') {
    // INCOMPLETE_COST_DATA o INVALID_COST_DATA — el motor ya rechazó, sin escritura.
    return { notFound: false, applied: false, status: result.status, result };
  }

  if (!result.final || result.final.valid !== true) {
    // Configuración económicamente inválida (ej. CV%+M>=1) — propagada, no oculta.
    return { notFound: false, applied: false, status: APPLY_STATUS.CALCULATION_INVALID, result };
  }

  if (params.expectedFinalGrossPrice != null && !monetaryEquals(params.expectedFinalGrossPrice, result.final.finalGrossPrice)) {
    return { notFound: false, applied: false, status: APPLY_STATUS.PRICE_DRIFTED, result };
  }

  await product.update({
    price: result.final.finalGrossPrice,
    pricingSource: 'engine',
    pricingCostSnapshot: result.costPrice,
    pricingCalculatedPrice: result.final.finalGrossPrice,
    pricingAppliedAt: new Date(),
  });

  return { notFound: false, applied: true, status: APPLY_STATUS.APPLIED, result };
}

module.exports = {
  previewEnginePrice,
  applyEnginePrice,
  monetaryEquals,
  toCents,
  APPLY_STATUS,
};
