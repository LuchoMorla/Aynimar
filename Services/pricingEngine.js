'use strict';

/**
 * Pricing Engine de Aynimar — Paso 1: Cost Engine únicamente.
 *
 * Especificación completa: docs/PRICING_ENGINE_SPEC.md (sección B.1).
 * Este archivo NO calcula precios todavía — solo agrega componentes de costo
 * de forma genérica y trazable. Pricing Engine (P_min, margen objetivo) y
 * Commercial Engine se agregan en pasos posteriores, en este mismo archivo
 * (arquitectura física de Nivel 1 — spec sección H: un solo módulo, no
 * microservicios).
 *
 * Principio central: un costo `unknown` NUNCA se trata como `0`. Se excluye
 * de la suma (matemáticamente equivalente a 0 para *este* cálculo) pero
 * permanece visible en `unknownComponents`, y `costCoverage` señala que el
 * cálculo es parcial — nunca se genera una falsa sensación de precisión.
 *
 * Dropi es una FUENTE de datos posible (`source: 'dropi_catalog'`, etc.),
 * nunca parte de la fórmula — no hay ningún concepto `dropiCommission`
 * hardcodeado aquí.
 */

const { round2, toGross, extractFromGross } = require('./orderTotals');

const VALID_KINDS = ['absolute', 'percentage'];
const VALID_SCOPES = ['per_unit', 'per_order', 'per_shipment'];
const VALID_BASES = ['net_price', 'gross_price'];
const VALID_STATUSES = ['known', 'estimated', 'unknown'];

/**
 * @typedef {Object} CostComponent
 * @property {string} key      Identificador libre — 'product_cost', 'shipping',
 *                              'dropi_commission', 'payment_fee', etc. NO es un
 *                              enum cerrado (spec B.1.2).
 * @property {'absolute'|'percentage'} kind
 * @property {'per_unit'|'per_order'|'per_shipment'} scope  Ver spec B.1.1 —
 *   'per_unit' escala con `quantity`; 'per_order'/'per_shipment' NO escalan
 *   (son un monto compartido, no multiplicado por unidades de este producto).
 * @property {'net_price'|'gross_price'} [base]  Obligatorio solo si kind='percentage'.
 * @property {'known'|'estimated'|'unknown'} status
 * @property {number|null} value  null OBLIGATORIO si status='unknown' — nunca 0.
 * @property {string} source  Trazabilidad — de dónde viene el valor.
 */

/**
 * @typedef {Object} EconomicCost
 * @property {number} fixedAbsoluteCost   CF — suma de componentes 'absolute' (known+estimated).
 * @property {number} percentageCostRate  CV% — suma de componentes 'percentage', normalizados a base neta.
 * @property {CostComponent[]} componentsUsed
 * @property {CostComponent[]} unknownComponents  Nunca se descartan silenciosamente.
 * @property {number} costCoverage  0..1 — proporción known+estimated sobre el total de componentes.
 */

/**
 * Valida un CostComponent. Lanza un Error descriptivo si es inválido —
 * nunca corrige/normaliza silenciosamente un input incorrecto.
 * @param {CostComponent} component
 */
function validateCostComponent(component) {
  if (!component || typeof component !== 'object') {
    throw new Error('CostComponent inválido: se esperaba un objeto.');
  }

  const { key, kind, scope, base, status, value, source } = component;

  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('CostComponent.key es obligatorio y debe ser un string no vacío.');
  }
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(`CostComponent.kind inválido para "${key}": "${kind}" (válidos: ${VALID_KINDS.join(', ')}).`);
  }
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error(`CostComponent.scope inválido para "${key}": "${scope}" (válidos: ${VALID_SCOPES.join(', ')}).`);
  }
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`CostComponent.status inválido para "${key}": "${status}" (válidos: ${VALID_STATUSES.join(', ')}).`);
  }
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`CostComponent.source es obligatorio para "${key}" (trazabilidad — de dónde viene el valor).`);
  }

  if (kind === 'percentage' && !VALID_BASES.includes(base)) {
    throw new Error(
      `CostComponent.base es obligatorio y debe ser 'net_price'|'gross_price' cuando kind='percentage' (componente "${key}").`
    );
  }

  if (status === 'unknown') {
    if (value !== null) {
      throw new Error(
        `CostComponent "${key}" tiene status='unknown' pero value=${JSON.stringify(value)} — ` +
        `un costo desconocido DEBE tener value:null. Nunca se sustituye por 0.`
      );
    }
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`CostComponent "${key}" (status='${status}') requiere un value numérico finito.`);
    }
    if (value < 0) {
      throw new Error(
        `CostComponent "${key}" tiene value negativo (${value}) — un costo nunca es negativo ` +
        `(un rebate/subsidio es un concepto distinto, no soportado por este contrato).`
      );
    }
  }
}

/**
 * Factor de normalización de una tasa porcentual a la base 'net_price'.
 * Ver spec B.1: una comisión sobre PVP (gross) equivale, sobre precio neto,
 * a tasa × (1+taxRate).
 * @param {'net_price'|'gross_price'} base
 * @param {number} taxRate
 * @returns {number}
 */
function normalizeBaseFactor(base, taxRate) {
  return base === 'gross_price' ? 1 + taxRate : 1;
}

/**
 * Cost Engine — agrega una lista de CostComponent en un EconomicCost.
 *
 * No conoce Dropi, no conoce metodologías de asignación por producto: solo
 * agrega fielmente lo que se le entrega. La estimación/asignación de costos
 * per_order o per_shipment (spec B.1.1) es responsabilidad de quien arma el
 * `costComponents[]` antes de llamar a esta función, no de esta función.
 *
 * @param {Object} input
 * @param {number} [input.quantity=1]  Entero positivo. Solo escala componentes
 *   absolute con scope='per_unit'.
 * @param {CostComponent[]} input.costComponents
 * @param {number} input.taxRate  Parámetro explícito — nunca hardcodeado aquí
 *   (spec B.4). El caller pasa TAX_RATE de orderTotals.js.
 * @returns {EconomicCost}
 */
function computeEconomicCost({ quantity = 1, costComponents = [], taxRate }) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`quantity debe ser un entero positivo (recibido: ${JSON.stringify(quantity)}).`);
  }
  if (typeof taxRate !== 'number' || !Number.isFinite(taxRate) || taxRate < 0) {
    throw new Error(`taxRate debe ser un número finito >= 0 (recibido: ${JSON.stringify(taxRate)}).`);
  }
  if (!Array.isArray(costComponents)) {
    throw new Error('costComponents debe ser un array (puede ser vacío).');
  }

  costComponents.forEach(validateCostComponent);

  let fixedAbsoluteCost = 0;
  let percentageCostRate = 0;
  const componentsUsed = [];
  const unknownComponents = [];

  for (const component of costComponents) {
    if (component.status === 'unknown') {
      // Nunca contribuye a la suma, nunca se trata como 0 — solo se registra.
      unknownComponents.push(component);
      continue;
    }

    componentsUsed.push(component);

    if (component.kind === 'absolute') {
      const multiplier = component.scope === 'per_unit' ? quantity : 1;
      fixedAbsoluteCost += component.value * multiplier;
    } else {
      // percentage — nunca escala con quantity: es una tasa, no un monto.
      percentageCostRate += component.value * normalizeBaseFactor(component.base, taxRate);
    }
  }

  const totalComponents = costComponents.length;
  // Vacío = sin información = cobertura 0, no 1 — no queremos que la ausencia
  // total de datos se interprete como "economía completamente conocida".
  const costCoverage = totalComponents === 0
    ? 0
    : componentsUsed.length / totalComponents;

  return {
    fixedAbsoluteCost: round2(fixedAbsoluteCost),
    percentageCostRate,
    componentsUsed,
    unknownComponents,
    costCoverage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing Engine — Paso 2 (spec sección B.2).
//
// Calcula el PISO económico, no el precio comercial definitivo. Consume
// exclusivamente Cost Engine — no conoce Commercial Engine, Tax Engine (más
// allá de recibir taxRate como parámetro, igual que Cost Engine), ni
// Checkout. Nadie más en el sistema debe importar este archivo todavía
// (verificado por un test estructural en scripts/smoke-test.js).
// ─────────────────────────────────────────────────────────────────────────────

const CONFIDENCE_HIGH_THRESHOLD = 0.90;
const CONFIDENCE_MEDIUM_THRESHOLD = 0.50;

// Convención contractual (spec, sección "El costo real y el precio óptimo" y
// toda la investigación previa): el CostComponent que representa el costo
// puro de adquisición del producto usa esta key. Es el único lugar donde el
// nombre vive — si alguna vez cambia, cambia aquí y en ningún otro sitio.
const PRODUCT_COST_KEY = 'product_cost';

/**
 * Redondeo hacia arriba a 2 decimales — EXCLUSIVO para precios que son un
 * PISO económico (minimumNetPrice, marginTargetNetPrice).
 *
 * Por qué no se reutiliza `round2` (redondeo al más cercano) aquí: para un
 * piso, redondear al más cercano puede redondear HACIA ABAJO (ej. 3.7142857
 * → round2 → 3.71), dejando el precio realmente cobrado unos centavos por
 * debajo del mínimo matemático — el margen de contribución REAL resultaría
 * ligeramente inferior a `targetContributionMargin`. `round2` sigue siendo
 * correcto en todo lo demás (subtotal/tax/total de checkout, CF/CV% del Cost
 * Engine) porque esos no son garantías de piso, son sumas/agregaciones. Solo
 * un precio que promete "nunca menos de M" necesita redondear siempre hacia
 * arriba.
 *
 * Corrige ruido de punto flotante antes de aplicar el techo (redondea a 6
 * decimales primero) para que un valor exacto de centavo — representado
 * internamente como, por ejemplo, 8.000000000000002 — no se redondee hacia
 * el siguiente centavo por error de representación.
 *
 * @param {number} n
 * @returns {number}
 */
function ceil2(n) {
  const scaledAndCleaned = Math.round(n * 100 * 1e6) / 1e6;
  return Math.ceil(scaledAndCleaned) / 100;
}

/**
 * Umbrales de confidence — spec B.2.1. Único lugar donde viven estos números;
 * no se redefinen en ningún otro archivo.
 * @param {number} costCoverage  0..1
 * @returns {'high'|'medium'|'low'}
 */
function classifyConfidence(costCoverage) {
  if (typeof costCoverage !== 'number' || !Number.isFinite(costCoverage)) {
    throw new Error(`classifyConfidence: costCoverage debe ser un número finito (recibido: ${JSON.stringify(costCoverage)}).`);
  }
  if (costCoverage >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (costCoverage >= CONFIDENCE_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * @typedef {Object} PricingResult
 * @property {number|null} minimumNetPrice       P_min = CF/(1−CV%−M). null si !valid.
 * @property {number|null} marginTargetNetPrice  costo_producto puro / (1−M). null si !valid.
 * @property {number|null} recommendedNetPrice   max(minimumNetPrice, marginTargetNetPrice). null si !valid.
 * @property {number} targetContributionMargin   M usado (eco de la entrada, para trazabilidad).
 * @property {EconomicCost} economicCost         Salida completa del Cost Engine — fixedAbsoluteCost,
 *                                                percentageCostRate, costCoverage, unknownComponents, etc.
 * @property {'high'|'medium'|'low'} confidence
 * @property {string[]} warnings
 * @property {boolean} valid  false si CV%+M >= 1 (no existe precio finito que cumpla el objetivo).
 */

/**
 * Pricing Engine — calcula el piso económico y el precio objetivo por margen,
 * sobre un conjunto de CostComponent ya construido por el caller (spec B.1.1:
 * la ESTIMACIÓN/asignación de costos per_order/per_shipment ocurre ANTES de
 * llamar aquí — este motor no inventa ni corrige esos supuestos, solo agrega
 * y valida).
 *
 * IMPORTANTE — semántica de `quantity`: `minimumNetPrice`/`recommendedNetPrice`
 * son el piso/objetivo para el precio de ESA cantidad combinada (igual que
 * `computeEconomicCost`), NO se dividen automáticamente a "precio por unidad".
 * Para fijar `product.price` (siempre unitario) el caller debe invocar con
 * `quantity: 1` — es la forma de uso esperada en Nivel 1; `quantity` > 1 queda
 * disponible para usos futuros (ej. Profitability Engine sobre una línea real).
 *
 * @param {Object} input
 * @param {number} [input.quantity=1]
 * @param {CostComponent[]} input.costComponents
 * @param {number} input.taxRate                    Parámetro explícito — nunca hardcodeado (spec B.4).
 * @param {number} input.targetContributionMargin    M — margen de CONTRIBUCIÓN objetivo
 *   (`contribución/precio_neto`), NUNCA markup sobre costo. Ver spec, regla crítica 1.
 * @returns {PricingResult}
 */
function computePricingResult({ quantity = 1, costComponents = [], taxRate, targetContributionMargin }) {
  if (
    typeof targetContributionMargin !== 'number' ||
    !Number.isFinite(targetContributionMargin) ||
    targetContributionMargin < 0
  ) {
    throw new Error(
      `targetContributionMargin debe ser un número finito >= 0 (recibido: ${JSON.stringify(targetContributionMargin)}).`
    );
  }

  // Delega en Cost Engine — valida quantity/taxRate/costComponents y agrega
  // CF/CV%/costCoverage. Cualquier CostComponent inválido lanza aquí mismo.
  const economicCost = computeEconomicCost({ quantity, costComponents, taxRate });

  const M = targetContributionMargin;
  const warnings = [];

  if (economicCost.unknownComponents.length > 0) {
    warnings.push(
      `Este cálculo no considera ${economicCost.unknownComponents.length} componente(s) de costo ` +
      `desconocido(s): ${economicCost.unknownComponents.map((c) => c.key).join(', ')}. ` +
      `No se tratan como 0 — están excluidos de CF/CV%.`
    );
  }

  const estimatedOrderOrShipment = economicCost.componentsUsed.filter(
    (c) => c.status === 'estimated' && c.scope !== 'per_unit'
  );
  if (estimatedOrderOrShipment.length > 0) {
    warnings.push(
      `El piso incluye estimaciones por order/shipment (asignación asumida, NO costo exacto por ` +
      `producto — spec B.1.1): ${estimatedOrderOrShipment.map((c) => c.key).join(', ')}.`
    );
  }

  if (economicCost.fixedAbsoluteCost === 0) {
    warnings.push('fixedAbsoluteCost = 0 — verificar que sea intencional.');
  }
  if (M === 0) {
    warnings.push('targetContributionMargin = 0 — operando sin margen objetivo.');
  }

  const confidence = classifyConfidence(economicCost.costCoverage);

  // CV% + M >= 1: no existe precio finito que satisfaga el objetivo. Se
  // rechaza explícitamente — nunca se trunca ni se devuelve un precio
  // artificial (regla crítica 5).
  const denom = 1 - economicCost.percentageCostRate - M;
  if (denom <= 0) {
    warnings.push(
      `Configuración inválida: percentageCostRate (${economicCost.percentageCostRate}) + ` +
      `targetContributionMargin (${M}) >= 1 — ningún precio finito satisface el margen objetivo.`
    );
    return {
      minimumNetPrice: null,
      marginTargetNetPrice: null,
      recommendedNetPrice: null,
      targetContributionMargin: M,
      economicCost,
      confidence,
      warnings,
      valid: false,
    };
  }

  // ceil2, no round2: minimumNetPrice es un PISO — debe garantizar
  // contribución/precio >= M siempre, nunca "en promedio" o "salvo
  // redondeo". Ver comentario de ceil2().
  const minimumNetPrice = ceil2(economicCost.fixedAbsoluteCost / denom);

  // marginTargetNetPrice — margen objetivo sobre el costo de producto PURO
  // (key=PRODUCT_COST_KEY), no sobre CF completo. Convención consistente con
  // toda la investigación previa (docs/PRICING_ENGINE_SPEC.md) y con el
  // ejemplo `costo/(1-margen)` ya validado en checkout(). Se reutiliza
  // computeEconomicCost sobre el subconjunto filtrado — no se duplica lógica
  // de agregación/escalado por quantity.
  const productCostComponents = costComponents.filter((c) => c.key === PRODUCT_COST_KEY);
  if (productCostComponents.length === 0) {
    warnings.push(
      `No se encontró ningún CostComponent con key='${PRODUCT_COST_KEY}' — marginTargetNetPrice será 0 y no es significativo.`
    );
  } else if (productCostComponents.length > 1) {
    // No es necesariamente un error (podrían ser varios lotes a distinto
    // costo), pero es lo bastante inusual como para no pasar en silencio —
    // protege contra un key mal escrito que "coincida" por accidente más de
    // una vez, o contra sumar sin darse cuenta dos fuentes del mismo costo.
    warnings.push(
      `Se encontraron ${productCostComponents.length} CostComponent con key='${PRODUCT_COST_KEY}' — se sumaron todos. ` +
      `Verificar que sea intencional (ej. varios lotes a distinto costo), no una key duplicada por error.`
    );
  }
  const productCostOnly = computeEconomicCost({ quantity, taxRate, costComponents: productCostComponents });
  // M < 1 está garantizado en este punto (si M>=1, CV%+M>=1 también, ya se
  // rechazó arriba) — división segura.
  const marginTargetNetPrice = ceil2(productCostOnly.fixedAbsoluteCost / (1 - M));

  const recommendedNetPrice = Math.max(minimumNetPrice, marginTargetNetPrice);

  return {
    minimumNetPrice,
    marginTargetNetPrice,
    recommendedNetPrice,
    targetContributionMargin: M,
    economicCost,
    confidence,
    warnings,
    valid: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commercial Engine — Paso 3 (spec sección B.3). Revisión 2 (2026-09-06):
// separación explícita NETO ↔ PVP tras auditoría.
//
// Toma el resultado del Pricing Engine (el piso económico) y produce una
// PROPUESTA de precio comercial — nunca decide product.price, nunca toca
// checkout. El piso económico es una restricción que este motor NUNCA puede
// perforar salvo excepción explícita y auditada (B.3.2).
//
// LAS CUATRO ETAPAS — NO SON INTERCAMBIABLES, cada una vive en un dominio
// numérico distinto:
//
//   1. Economic floor (NETO)   → Pricing Engine (computePricingResult, ya
//      construido). `minimumNetPrice` — sin IVA.
//   2. Commercial strategy (NETO) → este archivo, `computeCommercialPrice`.
//      Estructural: candidato → FLOOR VALIDATION → `commercialNetPrice`.
//      Sigue siendo NETO — nunca aplica redondeo cosmético aquí.
//   3. PVP / GROSS              → Tax Engine (`orderTotals.js` + `toGross()`,
//      TODAVÍA NO conectado a este archivo — fuera de alcance del Paso 3).
//      Convierte `commercialNetPrice` → PVP sumando IVA.
//   4. Psychological rounding (PVP) → `applyGrossRoundingStrategy`, en este
//      archivo, pero **deliberadamente NO invocado** dentro de
//      `computeCommercialPrice`. Opera sobre el PVP que produce la etapa 3,
//      nunca sobre el neto de la etapa 2.
//
// Por qué esta separación importa: `ROUND_99(10.00 neto)` y `ROUND_99(11.50
// PVP)` NO son equivalentes — son números en dominios distintos que solo
// coinciden en la ETIQUETA de la estrategia, nunca en el resultado numérico
// correcto. Nombrar las funciones de redondeo con el prefijo "Gross" (en vez
// de un nombre genérico) hace sintácticamente imposible invocarlas sin que
// quede claro sobre qué dominio se espera que operen.
//
// `computeCommercialPrice` (etapa 2) NUNCA calcula IVA y NUNCA aplica
// redondeo psicológico — devuelve `commercialNetPrice` (neto, floor-
// protegido) junto con `presentationRoundingStrategy` (la estrategia
// SOLICITADA, como metadata a pasar a quien conecte la etapa 3+4 más
// adelante — Paso 4, todavía no autorizado). Esto deja el contrato
// preparado sin duplicar IVA ni importar Tax Engine prematuramente.
//
// Ayni-Créditos (computeCreditRedemption, orderTotals.js) NO pasa por nada
// de este archivo — es un mecanismo de pago ya existente, fuera del alcance
// del Commercial Engine (spec B.3.1). Nada aquí lo importa ni lo modifica.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_GROSS_ROUNDING_STRATEGIES = ['EXACT', 'ROUND_99', 'ROUND_95', 'ROUND_90', 'PREMIUM_ROUND'];

/**
 * Helper numérico PURO — redondea `price` hacia arriba al siguiente valor
 * que termina en `ending` (ej. ending=0.99 → 3.72 → 3.99). Nunca produce un
 * valor menor al de entrada. `price <= 0` pasa sin cambios.
 *
 * Sin semántica de dominio propia (no "sabe" si `price` es neto o PVP) — es
 * un utilitario aritmético. El dominio (SIEMPRE gross/PVP en este sistema) lo
 * define el nombre y la documentación de `applyGrossRoundingStrategy`, que es
 * el único punto de entrada público pensado para usarse en el pipeline.
 * @param {number} price
 * @param {number} ending  0 <= ending < 1
 * @returns {number}
 */
function roundUpToEnding(price, ending) {
  if (price <= 0) return price;
  const dollars = Math.floor(price + 1e-9);
  let candidate = round2(dollars + ending);
  if (candidate < price - 1e-9) candidate = round2(candidate + 1);
  return candidate;
}

/**
 * Registro de estrategias de REDONDEO DE PRESENTACIÓN — spec B.3: "Fase de
 * presentación... opera en PVP, después de Tax Engine". Estas funciones
 * están pensadas EXCLUSIVAMENTE para aplicarse al PVP (precio con IVA, lo
 * que el cliente ve) — nunca al precio neto del Pricing/Commercial Engine.
 * Ninguna es "mejor" universalmente — son hipótesis comerciales
 * configurables (ver docs/PRICING_ENGINE_SPEC.md e investigación de
 * psicología de precios previa: la evidencia real es mixta).
 */
const GROSS_ROUNDING_STRATEGIES = {
  EXACT: (grossPrice) => grossPrice,
  ROUND_99: (grossPrice) => roundUpToEnding(grossPrice, 0.99),
  ROUND_95: (grossPrice) => roundUpToEnding(grossPrice, 0.95),
  ROUND_90: (grossPrice) => roundUpToEnding(grossPrice, 0.90),
  PREMIUM_ROUND: (grossPrice) => {
    if (grossPrice <= 0) return grossPrice;
    return Math.ceil(round2(grossPrice) - 1e-9);
  },
};

/**
 * Aplica una estrategia de redondeo de PRESENTACIÓN a un **PVP** (precio con
 * IVA), por nombre, con la guardia externa obligatoria del spec:
 * `Math.max(strategy(grossPrice), grossPrice)`.
 *
 * ⚠️ `grossPrice` DEBE ser un PVP (con IVA) — nunca el `commercialNetPrice`
 * que devuelve `computeCommercialPrice`. Esta función no tiene forma de
 * detectar el error si se le pasa un neto por accidente (no conoce
 * `TAX_RATE`, no es su responsabilidad) — la prevención es de nomenclatura y
 * de disciplina de integración (Paso 4, Tax Engine), no de runtime.
 *
 * NO se invoca desde `computeCommercialPrice` — ver comentario de cabecera.
 * Queda lista y probada para cuando exista un punto de integración con Tax
 * Engine que produzca el PVP real a partir de `commercialNetPrice`.
 *
 * @param {number} grossPrice  PVP, con IVA ya incluido.
 * @param {string} strategyName  Una clave de GROSS_ROUNDING_STRATEGIES.
 * @returns {number}
 */
function applyGrossRoundingStrategy(grossPrice, strategyName) {
  if (typeof grossPrice !== 'number' || !Number.isFinite(grossPrice)) {
    throw new Error(`applyGrossRoundingStrategy: grossPrice debe ser un número finito (recibido: ${JSON.stringify(grossPrice)}).`);
  }
  const strategy = GROSS_ROUNDING_STRATEGIES[strategyName];
  if (typeof strategy !== 'function') {
    throw new Error(
      `applyGrossRoundingStrategy: estrategia desconocida "${strategyName}" (válidas: ${VALID_GROSS_ROUNDING_STRATEGIES.join(', ')}).`
    );
  }
  return Math.max(strategy(grossPrice), grossPrice);
}

/**
 * @typedef {Object} CommercialCandidate
 * @property {number} proposedNetPrice
 * @property {string} strategy    Nombre de la estrategia comercial/rationale — no necesariamente
 *                                 el mismo valor que la RoundingStrategy aplicada después.
 * @property {string} rationale
 * @property {boolean} [allowBelowFloor]  Excepción explícita (spec B.3.2) — SOLO para el contexto
 *   comercial concreto de esta propuesta (ej. una línea de regalo/bundle), NUNCA para el catálogo.
 * @property {string} [overrideReason]    Obligatorio si allowBelowFloor=true — auditable.
 */

/**
 * @typedef {Object} FloorValidationResult
 * @property {'APPROVED'|'REJECTED'|'ADJUSTED'|'APPROVED_BELOW_FLOOR'} status
 * @property {number} finalNetPrice
 * @property {string} [reason]
 */

// ── Justificación formal de 'APPROVED_BELOW_FLOOR' (revisión 2026-09-06) ───
//
// Se evaluó la alternativa de mantener SOLO los 3 estados literales del spec
// (APPROVED/REJECTED/ADJUSTED) y representar la excepción de B.3.2 mediante
// campos adicionales (allowBelowFloor/overrideReason/floorProtectionApplied)
// sobre status='APPROVED'. Se descartó esa alternativa deliberadamente:
// reutilizar 'APPROVED' para un precio por debajo del piso económico haría
// que alguien leyendo solo `status` (sin revisar cada campo adicional)
// concluyera que el precio fue económicamente viable — exactamente la
// confusión que el spec quiere evitar ("no debe confundirse con que el
// Pricing Engine considera rentable ese precio"). Un estado propio hace ese
// error estructuralmente más difícil: 'APPROVED_BELOW_FLOOR' nunca se puede
// confundir por accidente con 'APPROVED' en una comparación de string ni en
// un vistazo rápido al valor.
//
// Garantías de que NUNCA ocurre accidentalmente (todas verificadas con
// tests explícitos):
//   1. Requiere `candidate.allowBelowFloor === true` — comparación estricta,
//      NO truthy. `allowBelowFloor: 1` o `'true'` NO activan la excepción.
//   2. Requiere `candidate.overrideReason` como string no vacío (ni
//      `undefined`, ni `''`, ni solo espacios) — si falta, LANZA en vez de
//      degradar silenciosamente a otro estado.
//   3. `pricingResult` (el piso económico real, `minimumNetPrice`) nunca se
//      modifica ni se recalcula en este camino — el Pricing Engine sigue
//      señalando, sin alterar, cuál es el piso verdadero; la excepción vive
//      enteramente en `floorValidation`/`candidate`, nunca en `pricing`.
//   4. `reason` es OBLIGATORIO en este estado y siempre es el texto que el
//      caller proporcionó (auditable) — nunca un texto genérico.
//
// Es una excepción COMERCIAL/CONTEXTUAL (una línea, un bundle, una promoción
// puntual) — nunca una reinterpretación económica del piso ni un cambio de
// `product.price` en catálogo.

/**
 * Barrera de validación del piso económico — spec B.3, "todo candidato de
 * descuento/promoción comercial la atraviesa, sin excepción". Firma fiel al
 * spec: recibe el CommercialCandidate completo y el PricingResult completo
 * (no valores sueltos) para máxima trazabilidad.
 *
 * @param {CommercialCandidate} candidate
 * @param {PricingResult} pricingResult  Debe tener valid=true (ver computeCommercialPrice).
 * @returns {FloorValidationResult}
 */
function validateFloor(candidate, pricingResult) {
  if (!pricingResult || pricingResult.valid !== true || typeof pricingResult.minimumNetPrice !== 'number') {
    throw new Error('validateFloor requiere un PricingResult válido (valid=true) con minimumNetPrice numérico.');
  }
  const floor = pricingResult.minimumNetPrice;
  const proposed = candidate && candidate.proposedNetPrice;

  if (typeof proposed !== 'number' || !Number.isFinite(proposed) || proposed < 0) {
    return {
      status: 'REJECTED',
      finalNetPrice: floor,
      reason: `proposedNetPrice inválido (${JSON.stringify(proposed)}) — se usa el piso económico como resguardo.`,
    };
  }

  if (candidate.allowBelowFloor === true) {
    if (typeof candidate.overrideReason !== 'string' || candidate.overrideReason.trim() === '') {
      throw new Error(
        'CommercialCandidate.allowBelowFloor=true requiere overrideReason no vacío (spec B.3.2 — excepción auditable, nunca silenciosa).'
      );
    }
    return { status: 'APPROVED_BELOW_FLOOR', finalNetPrice: proposed, reason: candidate.overrideReason };
  }

  if (proposed < floor) {
    return {
      status: 'ADJUSTED',
      finalNetPrice: floor,
      reason: `proposedNetPrice (${proposed}) < piso económico (${floor}) — elevado al piso.`,
    };
  }

  return { status: 'APPROVED', finalNetPrice: proposed };
}

/**
 * @typedef {Object} CommercialResult
 * @property {PricingResult} pricing            El PricingResult completo, sin copiar campos sueltos
 *                                               (fixedAbsoluteCost/percentageCostRate/confidence/etc.
 *                                               viven únicamente aquí — única fuente de verdad).
 * @property {CommercialCandidate} candidate      El candidato ANTES de floor validation.
 * @property {FloorValidationResult} floorValidation
 * @property {number|null} commercialNetPrice     Precio comercial final, **NETO** (post floor
 *   validation, SIN redondeo de presentación — ver `presentationRoundingStrategy`). null si !valid.
 * @property {boolean} floorProtectionApplied     true si floorValidation.status === 'ADJUSTED'.
 * @property {string} presentationRoundingStrategy  Estrategia SOLICITADA para la etapa de
 *   presentación (aplicable sobre PVP, no sobre `commercialNetPrice`) — metadata que se pasa a
 *   quien conecte el Tax Engine (Paso 4). Este motor NO la aplica todavía — ver `applyGrossRoundingStrategy`.
 * @property {{referencePrice:number, delta:number, deltaPercent:number}|null} reference
 *   Solo presente si el caller proporcionó `referencePrice` explícito y válido — NUNCA inventado.
 * @property {string[]} warnings                  Warnings PROPIOS de este motor — no duplica los de `pricing.warnings`.
 * @property {boolean} valid                      Propaga pricing.valid — sin piso válido no hay precio comercial.
 */

/**
 * Commercial Engine — Fase ESTRUCTURAL únicamente (spec B.3: "opera en
 * precio neto"). Produce una propuesta de precio comercial NETO sobre el
 * piso económico ya calculado por el Pricing Engine.
 *
 * NO aplica redondeo de presentación (.99/.95/.90/premium) — esa es la Fase
 * de presentación del spec, que opera sobre PVP, después de Tax Engine
 * (Paso 4, todavía no autorizado). `strategyName` se recibe y se devuelve
 * como `presentationRoundingStrategy` — metadata lista para cuando exista el
 * punto de integración con Tax Engine, pero **no se ejecuta aquí**. Ver
 * `applyGrossRoundingStrategy` para la función que sí la aplica, sobre PVP.
 *
 * Contrato de garantía (spec, regla fundamental): `commercialNetPrice` nunca
 * es menor a `pricing.minimumNetPrice`, salvo excepción explícita y auditada
 * (`allowBelowFloor` + `overrideReason` — B.3.2, nunca modifica product.price,
 * solo esta propuesta puntual). Ver justificación formal de
 * 'APPROVED_BELOW_FLOOR' más arriba.
 *
 * @param {Object} input
 * @param {PricingResult} input.pricingResult   Salida de computePricingResult().
 * @param {number} [input.manualNetPrice]       Candidato explícito, NETO. Si se omite, se usa
 *   `pricingResult.recommendedNetPrice` (el default del Pricing Engine).
 * @param {string} [input.strategyName='EXACT'] Estrategia de presentación SOLICITADA — se propaga
 *   como metadata (`presentationRoundingStrategy`), no se aplica en este paso.
 * @param {string} [input.rationale]            Motivo del candidato, para trazabilidad.
 * @param {number} [input.referencePrice]       Precio de referencia REAL (ancla), NETO, provisto
 *   por el caller — este motor NUNCA inventa uno. Si se omite, `reference` es null.
 * @param {boolean} [input.allowBelowFloor]     Excepción de contexto (B.3.2) — nunca cambia el catálogo.
 * @param {string} [input.overrideReason]       Obligatorio si allowBelowFloor=true.
 * @returns {CommercialResult}
 */
function computeCommercialPrice({
  pricingResult,
  manualNetPrice,
  strategyName = 'EXACT',
  rationale,
  referencePrice,
  allowBelowFloor,
  overrideReason,
}) {
  if (!pricingResult || typeof pricingResult !== 'object') {
    throw new Error('computeCommercialPrice requiere pricingResult (salida de computePricingResult()).');
  }
  if (!VALID_GROSS_ROUNDING_STRATEGIES.includes(strategyName)) {
    throw new Error(
      `strategyName inválido "${strategyName}" (válidas: ${VALID_GROSS_ROUNDING_STRATEGIES.join(', ')}).`
    );
  }

  const warnings = [];

  // Sin piso económico válido no hay nada sobre lo que proponer un precio
  // comercial — se propaga la invalidez, nunca se inventa un número.
  if (!pricingResult.valid) {
    warnings.push('pricingResult.valid = false — no se puede proponer un precio comercial sin un piso económico válido.');
    return {
      pricing: pricingResult,
      candidate: null,
      floorValidation: null,
      commercialNetPrice: null,
      floorProtectionApplied: false,
      presentationRoundingStrategy: strategyName,
      reference: null,
      warnings,
      valid: false,
    };
  }

  const proposedNetPrice = manualNetPrice != null ? manualNetPrice : pricingResult.recommendedNetPrice;
  const candidate = {
    proposedNetPrice,
    strategy: strategyName,
    rationale: rationale || (manualNetPrice != null ? 'manual_override' : 'margin_default'),
    allowBelowFloor,
    overrideReason,
  };

  const floorValidation = validateFloor(candidate, pricingResult);

  if (floorValidation.status === 'ADJUSTED') {
    warnings.push(
      `Precio propuesto (${proposedNetPrice}) por debajo del piso económico (${pricingResult.minimumNetPrice}) — ` +
      `protegido, elevado al piso.`
    );
  } else if (floorValidation.status === 'REJECTED') {
    warnings.push(`Precio propuesto inválido — se usó el piso económico (${pricingResult.minimumNetPrice}) como resguardo.`);
  } else if (floorValidation.status === 'APPROVED_BELOW_FLOOR') {
    warnings.push(
      `Precio por debajo del piso económico AUTORIZADO explícitamente ("${floorValidation.reason}") — ` +
      `excepción de contexto comercial, product.price del catálogo NO se modifica.`
    );
  }

  if (strategyName !== 'EXACT') {
    warnings.push(
      `Estrategia de presentación '${strategyName}' solicitada pero NO aplicada — opera sobre PVP ` +
      `(Fase de presentación, spec B.3), no sobre este precio neto. Pendiente de Tax Engine (Paso 4).`
    );
  }

  // commercialNetPrice = el precio NETO ya protegido por el piso — SIN
  // redondeo de presentación. La Fase de presentación (.99/.95/.90/premium)
  // opera sobre PVP y es responsabilidad de quien conecte Tax Engine después
  // (ver applyGrossRoundingStrategy). Aplicar aquí una función llamada
  // "ROUND_99" sobre un neto produciría un número con apariencia de PVP que
  // en realidad no lo es — exactamente la confusión que esta separación evita.
  const commercialNetPrice = floorValidation.finalNetPrice;

  let reference = null;
  if (referencePrice !== undefined) {
    if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) {
      warnings.push(`referencePrice inválido (${JSON.stringify(referencePrice)}) — ignorado, no se genera anclaje.`);
    } else {
      const delta = round2(referencePrice - commercialNetPrice);
      const deltaPercent = referencePrice > 0 ? round2((delta / referencePrice) * 100) / 100 : 0;
      if (delta <= 0) {
        warnings.push(
          'referencePrice no es mayor al precio comercial final — no representa un descuento real, no debe presentarse como "antes/ahora".'
        );
      }
      reference = { referencePrice, delta, deltaPercent };
    }
  }

  return {
    pricing: pricingResult,
    candidate,
    floorValidation,
    commercialNetPrice,
    floorProtectionApplied: floorValidation.status === 'ADJUSTED',
    presentationRoundingStrategy: strategyName,
    reference,
    warnings,
    valid: true,
  };
}

/**
 * Piso económico CONSERVADOR de un bundle — NO es el "precio comercial
 * óptimo del bundle", es la suma de los pisos individuales que cada
 * componente necesitaría si se vendiera solo (spec: "evaluarse por
 * contribución económica TOTAL del pedido, no margen % promedio" — este es
 * el piso más simple y defendible que cumple ese principio: garantiza que el
 * bundle en su conjunto nunca vende por menos de lo que costaría cubrir cada
 * pieza individualmente).
 *
 * Semántica exacta: "piso económico conservador del bundle bajo la
 * hipótesis de que cada componente debe respetar individualmente su propio
 * piso". Un bundle con subsidio cruzado deliberado (ej. un accesorio barato
 * como loss-leader dentro de un paquete rentable en conjunto) es una
 * decisión comercial CONSCIENTE, no algo que esta función decida — se
 * soporta pasando el resultado de esta función como `pricingResult` (un
 * "pseudo-producto") a `computeCommercialPrice` con `allowBelowFloor` +
 * `overrideReason` explícitos, exactamente el mismo mecanismo que protege
 * la excepción de producto gratuito (B.3.2) — no hay ni se necesita una
 * fórmula de optimización de bundles aparte en este paso.
 *
 * Ningún dato inventado — solo reutiliza PricingResult ya calculados por el
 * Pricing Engine para cada componente.
 *
 * @param {PricingResult[]} componentPricingResults  Uno por cada producto del bundle.
 * @returns {{bundleEconomicFloor: number, components: number, allValid: boolean}}
 */
function computeBundleEconomicFloor(componentPricingResults) {
  if (!Array.isArray(componentPricingResults) || componentPricingResults.length === 0) {
    throw new Error('computeBundleEconomicFloor requiere un array no vacío de PricingResult.');
  }
  let allValid = true;
  let bundleEconomicFloor = 0;
  for (const pr of componentPricingResults) {
    if (!pr || pr.valid !== true || typeof pr.minimumNetPrice !== 'number') {
      allValid = false;
      continue;
    }
    bundleEconomicFloor += pr.minimumNetPrice;
  }
  return {
    bundleEconomicFloor: allValid ? round2(bundleEconomicFloor) : null,
    components: componentPricingResults.length,
    allValid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Etapa de presentación — Paso 4. Completa la Fase de presentación que el
// Commercial Engine (Paso 3) dejó deliberadamente pendiente (spec B.3:
// "opera en PVP, después de Tax Engine").
//
// NO es el Tax Engine — no reimplementa conversión fiscal, la CONSUME
// (`toGross`/`extractFromGross`, únicas en Services/orderTotals.js). NO es
// tampoco una ampliación del Tax Engine con lógica de piso/margen: la
// protección de piso que aplica aquí opera sobre PVP usando `ceil2` (ya
// existente, Paso 2) — el Tax Engine en sí sigue sin saber qué es un "piso".
//
// Pipeline completo de esta función:
//   1. commercialResult.commercialNetPrice → toGross() → PVP "natural".
//   2. PVP natural → applyGrossRoundingStrategy() → PVP redondeado (.99/.95/.90/premium).
//   3. Verificación de piso EN PVP: minimumGrossForFloor = ceil2(floorNet×(1+taxRate)).
//      finalGrossPrice = max(PVP redondeado, minimumGrossForFloor) — nunca al revés.
//   4. finalGrossPrice → extractFromGross() → impliedNetPrice, solo para
//      verificación/trazabilidad (nunca la fuente de verdad del neto — esa
//      sigue siendo commercialResult.commercialNetPrice).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PresentationResult
 * @property {CommercialResult} commercial     El CommercialResult completo, sin copiar campos sueltos.
 * @property {number} taxRate
 * @property {{netPrice:number,taxRate:number,taxAmount:number,grossPrice:number}|null} netToGross
 *   Conversión "natural" (Tax Engine) del commercialNetPrice, ANTES de redondeo de presentación.
 * @property {number|null} roundedGrossPrice   Tras aplicar la estrategia de presentación.
 * @property {number|null} minimumGrossForFloor  Piso económico expresado en PVP (ceil2).
 * @property {number|null} finalGrossPrice     max(roundedGrossPrice, minimumGrossForFloor) — EL PVP final.
 * @property {number|null} impliedNetPrice     extractFromGross(finalGrossPrice).base — verificación, no fuente de verdad.
 * @property {boolean} floorProtectedAtGrossStage  true si minimumGrossForFloor tuvo que corregir hacia arriba.
 * @property {string[]} warnings
 * @property {boolean} valid  Propaga commercial.valid.
 */

/**
 * Calcula el PVP final — redondeo de presentación sobre el precio comercial
 * neto ya protegido por el piso, con una segunda verificación de piso
 * realizada EN PVP (nunca asumir que redondear el PVP conserva el piso
 * automáticamente — se verifica explícitamente, y se corrige si hace falta).
 *
 * Prioridad, en este orden, nunca invertido: (1) exactitud económica, (2)
 * cumplimiento fiscal, (3) protección del piso económico, (4) presentación
 * comercial. Un PVP visualmente atractivo NUNCA se acepta a costa de violar
 * el piso — `finalGrossPrice` lo garantiza por construcción (Math.max), no
 * por convención.
 *
 * @param {Object} input
 * @param {CommercialResult} input.commercialResult  Salida de computeCommercialPrice().
 * @param {number} input.taxRate                      Parámetro explícito — nunca hardcodeado.
 * @param {string} [input.strategyName]                Override opcional; por defecto usa
 *   `commercialResult.presentationRoundingStrategy` (la estrategia ya solicitada en la Fase estructural).
 * @returns {PresentationResult}
 */
function computeFinalGrossPrice({ commercialResult, taxRate, strategyName }) {
  if (!commercialResult || typeof commercialResult !== 'object') {
    throw new Error('computeFinalGrossPrice requiere commercialResult (salida de computeCommercialPrice()).');
  }
  if (typeof taxRate !== 'number' || !Number.isFinite(taxRate) || taxRate < 0) {
    throw new Error(`computeFinalGrossPrice: taxRate debe ser un número finito >= 0 (recibido: ${JSON.stringify(taxRate)}).`);
  }
  const effectiveStrategy = strategyName || commercialResult.presentationRoundingStrategy || 'EXACT';
  if (!VALID_GROSS_ROUNDING_STRATEGIES.includes(effectiveStrategy)) {
    throw new Error(
      `computeFinalGrossPrice: estrategia inválida "${effectiveStrategy}" (válidas: ${VALID_GROSS_ROUNDING_STRATEGIES.join(', ')}).`
    );
  }

  const warnings = [];

  if (!commercialResult.valid || commercialResult.commercialNetPrice == null) {
    warnings.push('commercialResult.valid = false — no hay precio comercial neto sobre el cual calcular PVP.');
    return {
      commercial: commercialResult,
      taxRate,
      netToGross: null,
      roundedGrossPrice: null,
      minimumGrossForFloor: null,
      finalGrossPrice: null,
      impliedNetPrice: null,
      floorProtectedAtGrossStage: false,
      warnings,
      valid: false,
    };
  }

  const netToGross = toGross(commercialResult.commercialNetPrice, taxRate);
  const roundedGrossPrice = applyGrossRoundingStrategy(netToGross.grossPrice, effectiveStrategy);
  const floorNet = commercialResult.pricing.minimumNetPrice;

  // VERIFICAR primero (exactitud económica, prioridad 1) — nunca asumir que
  // redondear el PVP conserva el piso automáticamente, aunque el redondeo
  // solo suba. Solo si la verificación encuentra una violación REAL se
  // corrige (prioridad 3) — y solo entonces, nunca de forma preventiva a
  // costa de cobrar de más sin necesidad (eso violaría la prioridad 1).
  const roundedImpliedNet = extractFromGross(roundedGrossPrice, taxRate).base;
  const floorProtectedAtGrossStage = roundedImpliedNet < floorNet;

  // minimumGrossForFloor: piso económico expresado en PVP — ceil2 (misma
  // política que minimumNetPrice, Paso 2). Se calcula siempre (para
  // trazabilidad/auditoría en el resultado) pero SOLO se usa como precio
  // final cuando la verificación de arriba detectó una violación real.
  const minimumGrossForFloor = ceil2(floorNet * (1 + taxRate));
  const finalGrossPrice = floorProtectedAtGrossStage
    ? Math.max(roundedGrossPrice, minimumGrossForFloor)
    : roundedGrossPrice;

  if (floorProtectedAtGrossStage) {
    warnings.push(
      `El PVP redondeado (${roundedGrossPrice}) implica un neto (${roundedImpliedNet}) por debajo del piso ` +
      `económico (${floorNet}) — corregido hacia arriba a ${finalGrossPrice} (mínimo PVP que preserva el piso). ` +
      `La presentación comercial NUNCA se antepone a la protección del piso.`
    );
  }

  const impliedNetPrice = extractFromGross(finalGrossPrice, taxRate).base;

  // Verificación FINAL explícita — no confiar solo en la corrección de
  // arriba. Si esto alguna vez fallara sería un bug real del motor, no un
  // caso de negocio válido — debe fallar ruidosamente, nunca en silencio.
  if (impliedNetPrice < floorNet) {
    throw new Error(
      `Invariante violada: impliedNetPrice (${impliedNetPrice}) < floorNet (${floorNet}) después de la ` +
      `protección de piso en PVP. Esto es un bug del motor, repórtalo — nunca debería ocurrir.`
    );
  }

  return {
    commercial: commercialResult,
    taxRate,
    netToGross,
    roundedGrossPrice,
    minimumGrossForFloor,
    finalGrossPrice,
    impliedNetPrice,
    floorProtectedAtGrossStage,
    warnings,
    valid: true,
  };
}

module.exports = {
  VALID_KINDS,
  VALID_SCOPES,
  VALID_BASES,
  VALID_STATUSES,
  PRODUCT_COST_KEY,
  validateCostComponent,
  normalizeBaseFactor,
  computeEconomicCost,
  classifyConfidence,
  ceil2,
  computePricingResult,
  VALID_GROSS_ROUNDING_STRATEGIES,
  GROSS_ROUNDING_STRATEGIES,
  roundUpToEnding,
  applyGrossRoundingStrategy,
  validateFloor,
  computeCommercialPrice,
  computeBundleEconomicFloor,
  computeFinalGrossPrice,
};
