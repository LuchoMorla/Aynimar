'use strict';

/**
 * Contribución por pedido y PVP mínimo rentable — módulo PURO (sin DB, sin red).
 *
 * Reutiliza el Tax Engine (orderTotals.js: TAX_RATE, extractFromGross, round2)
 * y el Pricing Engine (pricingEngine.js: computePricingResult, ceil2) — no
 * reimplementa IVA ni el piso económico.
 *
 * Modelo, por PEDIDO DESPACHADO (valores esperados):
 *   gross       = PVP × qty × deliveryRate      (en COD solo se cobra lo entregado)
 *   vat         = IVA contenido en gross (PVP incluye IVA 15%)
 *   netRevenue  = gross / 1.15
 *   cogs        = costeNeto × qty × deliveryRate (lo devuelto vuelve al stock del proveedor)
 *                 costeNeto = cost/1.15 si costIncludesVat (IVA del coste como crédito tributario),
 *                 cost si no. Si el IVA del coste NO fuera recuperable, el coste real = cost,
 *                 que es exactamente el supuesto costIncludesVat=false (cubierto por el rango).
 *   logistics   = shipping (flete de ida, se paga en todo pedido despachado)
 *   commissions = commissionRate × gross        (comisión sobre el recaudo, con IVA)
 *   expectedReturnsCost = returnRate × returnCost
 *   contribution = netRevenue − cogs − logistics − commissions − expectedReturnsCost
 *   marginOnNet  = contribution / netRevenue
 *
 * Datos desconocidos: NUNCA se inventan. Un input null/undefined se resuelve
 * con `assumptions[campo] = [min, max]` (supuesto explícito del caller) y se
 * calcula un rango; sin supuesto → `incomplete:true` + `missing`.
 * `costIncludesVat:null` calcula ambos supuestos. La contribución es
 * multilineal en sus inputs, así que sus extremos están en las esquinas del
 * rango: se evalúan todas (≤ 2^7).
 */

const { TAX_RATE, round2, extractFromGross } = require('./orderTotals');
const { computePricingResult, ceil2, PRODUCT_COST_KEY } = require('./pricingEngine');

const RANGED_FIELDS = ['cost', 'shipping', 'returnRate', 'returnCost', 'commissionRate', 'deliveryRate'];
const RATE_FIELDS = ['returnRate', 'commissionRate', 'deliveryRate'];

const isMissing = (v) => v === null || v === undefined;

/** Resuelve cada input a una lista de valores posibles (1 = conocido, 2 = rango). */
function resolveInputs(input, assumptions = {}) {
  const values = {};
  const uncertain = [];
  const missing = [];

  for (const f of RANGED_FIELDS) {
    const v = input[f];
    if (!isMissing(v)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${f} inválido: ${JSON.stringify(v)}`);
      if (RATE_FIELDS.includes(f) && v > 1) throw new Error(`${f} es una tasa 0..1 (recibido ${v})`);
      values[f] = [v];
      continue;
    }
    const a = assumptions[f];
    if (Array.isArray(a) && a.length === 2 && a.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) {
      values[f] = a[0] === a[1] ? [a[0]] : [Math.min(...a), Math.max(...a)];
      uncertain.push(`${f}: supuesto ${a[0]}–${a[1]}`);
    } else if (f === 'deliveryRate' || f === 'returnRate') {
      values[f] = null; // puede derivarse del otro (entregado + devuelto = 1)
    } else {
      missing.push(f);
    }
  }

  // Entregado y devuelto son complementarios por pedido despachado.
  if (values.deliveryRate === null && values.returnRate === null) {
    missing.push('deliveryRate|returnRate');
  } else if (values.deliveryRate === null) {
    values.deliveryRate = 'derived';
    uncertain.push('deliveryRate: derivado como 1 − returnRate');
  } else if (values.returnRate === null) {
    values.returnRate = 'derived';
    uncertain.push('returnRate: derivado como 1 − deliveryRate');
  }

  if (input.costIncludesVat === true || input.costIncludesVat === false) {
    values.costIncludesVat = [input.costIncludesVat];
  } else {
    values.costIncludesVat = [false, true];
    uncertain.push('costIncludesVat: desconocido, se calculan ambos supuestos');
  }

  return { values, uncertain, missing };
}

/** Todas las combinaciones de valores (producto cartesiano), resolviendo los derivados. */
function corners(values) {
  let out = [{}];
  for (const [k, list] of Object.entries(values)) {
    if (list === 'derived') continue;
    out = out.flatMap((c) => list.map((v) => ({ ...c, [k]: v })));
  }
  for (const c of out) {
    if (values.deliveryRate === 'derived') c.deliveryRate = 1 - c.returnRate;
    if (values.returnRate === 'derived') c.returnRate = 1 - c.deliveryRate;
  }
  return out;
}

function breakdown({ pvp, qty, taxRate }, c) {
  const { base, taxAmount } = extractFromGross(pvp * qty * c.deliveryRate, taxRate);
  const netCost = c.costIncludesVat ? c.cost / (1 + taxRate) : c.cost;
  const gross = round2(pvp * qty * c.deliveryRate);
  const cogs = round2(netCost * qty * c.deliveryRate);
  const logistics = round2(c.shipping);
  const commissions = round2(c.commissionRate * gross);
  const expectedReturnsCost = round2(c.returnRate * c.returnCost);
  const contribution = round2(base - cogs - logistics - commissions - expectedReturnsCost);
  return {
    gross, vat: taxAmount, netRevenue: base, cogs, logistics, commissions, expectedReturnsCost, contribution,
    marginOnNet: base > 0 ? Math.round((contribution / base) * 10000) / 10000 : null,
    scenario: c,
  };
}

function validateBase({ pvp, qty = 1 }) {
  if (typeof pvp !== 'number' || !Number.isFinite(pvp) || pvp <= 0) throw new Error(`pvp inválido: ${JSON.stringify(pvp)}`);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`qty debe ser entero positivo: ${JSON.stringify(qty)}`);
}

/**
 * @param {Object} input
 * @param {number} input.pvp  PVP unitario CON IVA (products.price).
 * @param {number} [input.qty=1]
 * @param {number|null} input.cost  Coste unitario del proveedor.
 * @param {boolean|null} input.costIncludesVat
 * @param {number|null} input.shipping  Flete de ida por pedido.
 * @param {number|null} input.returnRate  0..1 de pedidos despachados que se devuelven.
 * @param {number|null} input.returnCost  Coste por devolución (tarifa de retorno).
 * @param {number|null} input.commissionRate  0..1 sobre el recaudo (PVP).
 * @param {number|null} input.deliveryRate  0..1 de pedidos despachados entregados.
 * @param {Object} [input.assumptions]  { campo: [min, max] } para datos desconocidos.
 * @param {number} [input.taxRate=TAX_RATE]
 * @returns {{incomplete:boolean, missing:string[], uncertain:string[], ...breakdown peor caso,
 *   best: Object|null, range: {contribution:[number,number], marginOnNet:[number,number]}|null}}
 *   Los campos de primer nivel son el PEOR caso (conservador); `best` el mejor.
 */
function contributionPerOrder(input) {
  const { pvp, qty = 1, taxRate = TAX_RATE, assumptions } = input || {};
  validateBase({ pvp, qty });
  const { values, uncertain, missing } = resolveInputs(input, assumptions);

  if (missing.length) {
    return {
      incomplete: true, missing, uncertain,
      gross: null, vat: null, netRevenue: null, cogs: null, logistics: null, commissions: null,
      expectedReturnsCost: null, contribution: null, marginOnNet: null, best: null, range: null,
    };
  }

  const results = corners(values).map((c) => breakdown({ pvp, qty, taxRate }, c));
  const byContribution = [...results].sort((a, b) => a.contribution - b.contribution);
  const margins = results.map((r) => r.marginOnNet).filter((m) => m !== null);
  const worst = byContribution[0];
  const best = byContribution[byContribution.length - 1];

  return {
    incomplete: false, missing, uncertain,
    ...worst,
    best,
    range: {
      contribution: [worst.contribution, best.contribution],
      marginOnNet: margins.length ? [Math.min(...margins), Math.max(...margins)] : null,
    },
  };
}

/**
 * PVP mínimo (CON IVA, unitario) para que contribution/netRevenue >= targetMargin.
 * Reutiliza computePricingResult: CF = coste neto + (flete + returnRate×returnCost)/deliveryRate
 * por pedido entregado; CV% = comisión sobre PVP (base gross_price).
 * Con rango de supuestos devuelve el PVP del peor caso (el más alto) y el rango.
 *
 * @returns {{incomplete:boolean, missing:string[], uncertain:string[], minPvp:number|null,
 *   range:[number,number]|null, valid:boolean, warnings:string[]}}
 */
function minProfitablePrice(input) {
  const { qty = 1, targetMargin = 0.30, taxRate = TAX_RATE, assumptions } = input || {};
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`qty debe ser entero positivo: ${JSON.stringify(qty)}`);
  const { values, uncertain, missing } = resolveInputs(input, assumptions);
  if (missing.length) return { incomplete: true, missing, uncertain, minPvp: null, range: null, valid: false, warnings: [] };

  const prices = [];
  const warnings = [];
  for (const c of corners(values)) {
    if (c.deliveryRate <= 0) { warnings.push('deliveryRate = 0 — ningún precio es rentable'); prices.push(null); continue; }
    const netCost = c.costIncludesVat ? c.cost / (1 + taxRate) : c.cost;
    const r = computePricingResult({
      quantity: qty,
      taxRate,
      targetContributionMargin: targetMargin,
      costComponents: [
        { key: PRODUCT_COST_KEY, kind: 'absolute', scope: 'per_unit', status: 'known', value: netCost, source: 'finance.cost' },
        {
          key: 'logistics_per_delivered_order', kind: 'absolute', scope: 'per_order', status: 'estimated',
          value: (c.shipping + c.returnRate * c.returnCost) / c.deliveryRate, source: 'finance.shipping+returns',
        },
        { key: 'commission', kind: 'percentage', base: 'gross_price', scope: 'per_order', status: 'known', value: c.commissionRate, source: 'finance.commission' },
      ],
    });
    if (!r.valid) { warnings.push(...r.warnings); prices.push(null); continue; }
    prices.push(ceil2((r.minimumNetPrice * (1 + taxRate)) / qty));
  }

  if (prices.includes(null)) return { incomplete: false, missing, uncertain, minPvp: null, range: null, valid: false, warnings };
  return {
    incomplete: false, missing, uncertain,
    minPvp: Math.max(...prices),
    range: [Math.min(...prices), Math.max(...prices)],
    valid: true, warnings,
  };
}

/** Compara varios PVP (precio o precio con descuento) con el resto de inputs fijos. */
function simulatePrices(base, pvps) {
  return pvps.map((pvp) => {
    const r = contributionPerOrder({ ...base, pvp });
    return { pvp, incomplete: r.incomplete, contribution: r.contribution, marginOnNet: r.marginOnNet, range: r.range, missing: r.missing };
  });
}

/**
 * Clasifica un producto para el informe. rentable = peor caso ≥ objetivo;
 * no_rentable = mejor caso < objetivo; si depende de los supuestos → incompleto.
 */
function classifyProfitability(result, targetMargin = 0.30) {
  if (result.incomplete) return { status: 'incompleto', reason: `faltan: ${result.missing.join(', ')}` };
  const [mMin, mMax] = result.range.marginOnNet || [null, null];
  const [cMin, cMax] = result.range.contribution;
  if (cMax <= 0) return { status: 'no_rentable', reason: `pierde dinero (contribución ${cMin}…${cMax} por pedido)` };
  if (mMax !== null && mMax < targetMargin) return { status: 'no_rentable', reason: `margen ${pct(mMin)}–${pct(mMax)} < objetivo ${pct(targetMargin)}` };
  if (mMin !== null && mMin >= targetMargin && cMin > 0) return { status: 'rentable', reason: `margen ${pct(mMin)}–${pct(mMax)}` };
  return { status: 'incompleto', reason: `depende de supuestos: margen ${pct(mMin)}–${pct(mMax)}` };
}

const pct = (x) => (x === null || x === undefined ? '?' : `${Math.round(x * 1000) / 10}%`);

module.exports = { contributionPerOrder, minProfitablePrice, simulatePrices, classifyProfitability, pct };
