'use strict';

/**
 * Pricing Authority — única fuente de verdad de la jerarquía
 * manual > engine > legacy_sync (Paso 9, protección de sincronizaciones).
 *
 * Puro, sin DB, sin efectos secundarios. Decide exclusivamente si un proceso
 * de sincronización automática (Dropi, Effi) tiene permiso para sobrescribir
 * `product.price` dado el `pricingSource` actual de la fila — no calcula
 * ningún precio, no conoce costo/margen/IVA, no es una fórmula de pricing.
 * routes/woocommerceMirror.js e integrations/importService.js CONSUMEN este
 * predicado; ninguno de los dos debe reimplementar esta regla por su cuenta.
 */

const PROTECTED_PRICING_SOURCES = ['manual', 'engine'];

/**
 * @param {string|null|undefined} pricingSource  Valor actual de la fila (product.pricingSource).
 * @returns {boolean} true si un sync automático puede escribir `price`.
 *   'manual'/'engine'            → false (protegido — decisión humana o del motor).
 *   'legacy_sync'/null/undefined → true (sobrescribible — sin decisión registrada).
 *   Cualquier otro valor         → true (mismo tratamiento que "sin decisión registrada").
 */
function canAutoSyncOverwritePrice(pricingSource) {
  return !PROTECTED_PRICING_SOURCES.includes(pricingSource);
}

module.exports = { canAutoSyncOverwritePrice, PROTECTED_PRICING_SOURCES };
