'use strict';

/**
 * Smart Shipping — adaptadores de cotización (Fase B; arquitectura en
 * ops-ceo-cto/informes/smart-shipping/01-fase-a.md §4.3).
 *
 * Interfaz única: quote(input) → options[]
 *   input  = { items:[{ dropiId, qty, declaredPrice }], cityId, cod:boolean }
 *   option = { carrierId, carrierName, cost, included, eta, restrictions[] }
 *     cost     — lo que la transportadora (vía Dropi) cobra a Aynimar, USD.
 *     included — flete ya incorporado en el PVP (provisión del SKU, CEO-021);
 *                null = sin provisión verificable → el servicio descarta la opción.
 *     eta      — texto SOLO si está confirmado por la fuente; si no, null.
 * Una opción sin cobertura simplemente no se devuelve (nunca se filtran
 * mensajes internos de Dropi al cliente).
 */

const CARRIERS = { 1: 'LaarCourier', 2: 'Servientrega', 3: 'Veloces' };

// SEMILLA DE DEV/TEST — NO es tarifa de producción. Cifras reales de
// `quote_shipping` (MCP Dropi, 2026-10-25, informe 01-fase-a §2.1) y flete de
// planificación de finanzas/formula_precio.py. En producción la tabla vive en
// app_settings.shipping_rates (la rellena la Fase D); sin ella no hay opciones.
const SEED_RATES = {
  asOf: '2026-10-25',
  source: 'Dropi MCP quote_shipping (informe smart-shipping/01-fase-a §2.1) — semilla dev/test',
  carriers: CARRIERS,
  products: {
    // Trapeador (producto 101 de la tienda), declarado 32,99.
    112598: {
      included: 6.05,
      cities: {
        732: { cod: { 3: 4.90, 2: 5.52, 1: 7.01 }, prepaid: { 3: 4.14, 2: 3.70, 1: 5.12 } }, // Guayaquil
        802: { cod: { 3: 6.05, 2: 7.01, 1: 7.01 } },                                          // Quito
        807: { cod: { 2: 8.45, 1: 7.54 } },                                                   // Puerto Quito (rural)
        912: { cod: { 2: 8.45, 1: 8.36 } },                                                   // Macas (Amazonía)
      },
    },
    // Zapatero, declarado 50,99.
    133820: { included: 6.46, cities: { 732: { cod: { 3: 5.31, 2: 6.11, 1: 8.05 } } } },
  },
};

/**
 * Tabla precalculada (snapshot de `quote_shipping`). Un pedido = una guía:
 * por transportadora se toma el coste MÁS ALTO entre los productos y la
 * provisión más alta (Fase A §3.1: crédito = máx del flete de las líneas).
 * Una transportadora que no cubre algún producto del carrito se descarta.
 * ponytail: ignora cantidades y suma de valor declarado (≈ +2,3 % del valor);
 * la cotización en vivo (dropiLive) lo sustituirá.
 */
function dropiTable(input, table = SEED_RATES) {
  const mode = input.cod ? 'cod' : 'prepaid';
  const per = (input.items || []).map((it) => table?.products?.[String(it.dropiId)]);
  if (!per.length || per.some((p) => !p)) return [];
  const rates = per.map((p) => p.cities?.[String(input.cityId)]?.[mode] || {});
  const included = per.some((p) => typeof p.included !== 'number') ? null : Math.max(...per.map((p) => p.included));
  const carrierIds = Object.keys(rates[0]).filter((id) => rates.every((r) => typeof r[id] === 'number'));
  return carrierIds.map((id) => ({
    carrierId: Number(id),
    carrierName: table.carriers?.[id] || `Transportadora ${id}`,
    cost: Math.max(...rates.map((r) => r[id])),
    included,
    eta: null, // quote_shipping no devuelve tiempos (trajectory vacío): no se inventan.
    restrictions: [],
  }));
}

/** Determinista para dev/tests: una opción barata, una cara y una con restricción. */
function mock(input) {
  if (!input.items?.length || !input.cityId) return [];
  const base = input.cod ? 5 : 4;
  return [
    { carrierId: 3, carrierName: 'Veloces', cost: base, included: 6, eta: null, restrictions: [] },
    { carrierId: 2, carrierName: 'Servientrega', cost: base + 3.25, included: 6, eta: '24-48 h (mock)', restrictions: [] },
    { carrierId: 1, carrierName: 'LaarCourier', cost: base + 1, included: 6, eta: null, restrictions: ['Sin entrega en sábado (mock)'] },
  ];
}

/**
 * Cotización en vivo — STUB. PENDIENTE de soporte Dropi (decisión L2, Fase A
 * §3/§7): no hay endpoint de cotización documentado para el servidor (el MCP
 * es OAuth de usuario y no sirve en producción). No se implementa a ciegas.
 */
function dropiLive() {
  throw new Error('dropiLive no disponible: pendiente de endpoint de cotización de Dropi');
}

module.exports = { dropiTable, mock, dropiLive, SEED_RATES, CARRIERS };
