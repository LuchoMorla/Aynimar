'use strict';
/* eslint-disable no-console */
/**
 * Tests de Services/financeContribution.js — puros, sin DB ni red.
 *
 * Usage: node scripts/finance-test.js   (exit 0 = todo pasa)
 */

const {
  contributionPerOrder, minProfitablePrice, simulatePrices, classifyProfitability,
} = require('../Services/financeContribution');
const { buildTelegramSummary } = require('./finance-report');

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

const known = { qty: 1, costIncludesVat: false, shipping: 0, returnRate: 0, returnCost: 0, commissionRate: 0, deliveryRate: 1 };

// ── IVA: el PVP incluye 15 %, se extrae hacia atrás ──
const r1 = contributionPerOrder({ ...known, pvp: 11.5, cost: 5 });
assert('IVA: PVP 11.50 → neto 10.00 e IVA 1.50', r1.netRevenue === 10 && r1.vat === 1.5, JSON.stringify(r1));
assert('IVA: contribución = neto − coste = 5.00, margen 50 %', r1.contribution === 5 && r1.marginOnNet === 0.5, JSON.stringify(r1));
assert('datos completos → sin rango (min = max) y sin incertidumbre', r1.range.contribution[0] === r1.range.contribution[1] && r1.uncertain.length === 0);

const r1b = contributionPerOrder({ ...known, pvp: 11.5, cost: 5.75, costIncludesVat: true });
assert('coste con IVA (crédito tributario): 5.75 → coste neto 5.00', r1b.cogs === 5, JSON.stringify(r1b));

// ── Caso completo con flete, devoluciones y comisión ──
const r2 = contributionPerOrder({ pvp: 29.99, qty: 1, cost: 15, costIncludesVat: false, shipping: 6, returnRate: 0.3, returnCost: 6, commissionRate: 0.02 });
assert('deliveryRate derivado de returnRate (0.7) y anotado', r2.scenario.deliveryRate === 0.7 && r2.uncertain.some((u) => u.includes('deliveryRate')));
assert('caso real: cobro 20.99, cogs 10.50, flete 6, comisión 0.42, devoluciones 1.80',
  r2.gross === 20.99 && r2.cogs === 10.5 && r2.logistics === 6 && r2.commissions === 0.42 && r2.expectedReturnsCost === 1.8, JSON.stringify(r2));
assert('caso real: contribución negativa detectada (≈ −0.47)', r2.contribution < 0 && near(r2.contribution, -0.47), String(r2.contribution));
assert('caso real: clasificado no_rentable', classifyProfitability(r2).status === 'no_rentable');

// ── Rango cuando falta un dato ──
const r3 = contributionPerOrder({ ...known, pvp: 23, cost: 10, costIncludesVat: null });
assert('costIncludesVat null → rango con ambos supuestos', r3.range.contribution[0] === 10 && near(r3.range.contribution[1], 11.30), JSON.stringify(r3.range));
assert('costIncludesVat null → anotado en uncertain', r3.uncertain.some((u) => u.startsWith('costIncludesVat')));
assert('primer nivel = peor caso (conservador)', r3.contribution === r3.range.contribution[0]);

const r4 = contributionPerOrder({ ...known, pvp: 23, cost: 10, shipping: null, assumptions: { shipping: [5.5, 6.5] } });
assert('flete desconocido + supuesto → rango 3.50…4.50', r4.range.contribution[0] === 3.5 && r4.range.contribution[1] === 4.5, JSON.stringify(r4.range));

const r5 = contributionPerOrder({ ...known, pvp: 23, cost: null, shipping: null });
assert('coste y flete desconocidos sin supuesto → incomplete con missing', r5.incomplete && r5.missing.includes('cost') && r5.missing.includes('shipping') && r5.contribution === null, JSON.stringify(r5));
assert('incomplete → clasificado incompleto', classifyProfitability(r5).status === 'incompleto');
assert('nunca se inventa 0 para un dato faltante', r5.cogs === null && r5.logistics === null);

const r6 = contributionPerOrder({ ...known, pvp: 23, cost: 10, deliveryRate: undefined, returnRate: undefined });
assert('sin tasa de entrega ni devolución → incomplete', r6.incomplete && r6.missing.includes('deliveryRate|returnRate'));

// ── price = cost (riesgo DROPI_MARGIN_PERCENT=0 en woocommerceMirror.js) ──
const r7 = contributionPerOrder({ ...known, pvp: 20, cost: 20 });
assert('price = cost → margen negativo tras IVA', r7.contribution < 0 && r7.marginOnNet < 0, JSON.stringify(r7));
assert('price = cost → no_rentable', classifyProfitability(r7).status === 'no_rentable');
const r7b = contributionPerOrder({ ...known, pvp: 20, cost: 20, costIncludesVat: null });
assert('price = cost con IVA del coste desconocido → no_rentable en ambos supuestos', classifyProfitability(r7b).status === 'no_rentable', JSON.stringify(r7b.range));

// ── Rentable / dependiente de supuestos ──
assert('margen 50 % con objetivo 30 % → rentable', classifyProfitability(r1, 0.30).status === 'rentable');
const r8 = contributionPerOrder({ ...known, pvp: 23, cost: 13, costIncludesVat: null });
// neto 20; coste neto 13 (margen 35 %) o 11.30 (margen 43.5 %) → rentable en ambos
assert('rentable en ambos supuestos de IVA del coste', classifyProfitability(r8).status === 'rentable', JSON.stringify(r8.range));
const r9 = contributionPerOrder({ ...known, pvp: 23, cost: 15, costIncludesVat: null });
// coste neto 15 (25 %) o 13.04 (34.8 %) → depende
assert('margen que cruza el objetivo según supuesto → incompleto', classifyProfitability(r9).status === 'incompleto', JSON.stringify(r9.range));

// ── Precio mínimo ──
const m1 = minProfitablePrice({ ...known, cost: 7, targetMargin: 0.30 });
assert('precio mínimo: coste 7, margen 30 % → neto 10 → PVP 11.50', m1.valid && m1.minPvp === 11.5, JSON.stringify(m1));
const check1 = contributionPerOrder({ ...known, pvp: m1.minPvp, cost: 7 });
assert('en el PVP mínimo el margen ≥ objetivo', check1.marginOnNet >= 0.30, String(check1.marginOnNet));

const m2 = minProfitablePrice({ cost: 15, costIncludesVat: null, shipping: 6, returnRate: 0.3, returnCost: 6, commissionRate: 0.02, targetMargin: 0.30 });
const check2 = contributionPerOrder({ pvp: m2.minPvp, cost: 15, costIncludesVat: null, shipping: 6, returnRate: 0.3, returnCost: 6, commissionRate: 0.02 });
assert('precio mínimo con flete/devoluciones: peor caso del rango y margen ≥ 30 % en todos los supuestos',
  m2.valid && m2.minPvp === m2.range[1] && check2.range.marginOnNet[0] >= 0.30 - 0.001, JSON.stringify({ m2, r: check2.range }));
const below = contributionPerOrder({ pvp: Math.round((m2.minPvp - 0.5) * 100) / 100, cost: 15, costIncludesVat: false, shipping: 6, returnRate: 0.3, returnCost: 6, commissionRate: 0.02 });
assert('50 centavos por debajo del mínimo → margen < 30 %', below.marginOnNet < 0.30, String(below.marginOnNet));

const m3 = minProfitablePrice({ ...known, cost: 7, commissionRate: 0.8, targetMargin: 0.30 });
assert('comisión + margen ≥ 100 % → sin precio válido (no se inventa)', m3.valid === false && m3.minPvp === null, JSON.stringify(m3));
const m4 = minProfitablePrice({ ...known, cost: null });
assert('precio mínimo con coste desconocido → incomplete', m4.incomplete && m4.minPvp === null);

// ── Simulación de precios ──
const sim = simulatePrices({ ...known, cost: 7 }, [11.5, 10.35, 9.2]);
assert('simulatePrices: un resultado por PVP', sim.length === 3 && sim[0].pvp === 11.5);
assert('simulatePrices: el descuento reduce el margen', sim[0].marginOnNet > sim[1].marginOnNet && sim[1].marginOnNet > sim[2].marginOnNet, JSON.stringify(sim));

// ── Validación de entrada ──
let threw = false;
try { contributionPerOrder({ ...known, pvp: 10, cost: 5, returnRate: 1.5 }); } catch { threw = true; }
assert('tasa > 1 → error explícito', threw);
threw = false;
try { contributionPerOrder({ ...known, pvp: -1, cost: 5 }); } catch { threw = true; }
assert('PVP negativo → error explícito', threw);

// ── Resumen Telegram ──
const many = Array.from({ length: 300 }, (_, i) => ({
  id: i, name: `Producto <b>${i}</b> con un nombre bastante largo para ocupar espacio`, pvp: 20,
  status: 'incompleto', reason: 'faltan: cost',
}));
const msg = buildTelegramSummary({ rows: many, targetMargin: 0.3, assumptionsText: 'ninguno', env: 'staging' });
assert('resumen Telegram ≤ 4000 caracteres', msg.length <= 4000, String(msg.length));
assert('resumen Telegram escapa HTML de nombres', !msg.includes('<b>0</b>') && msg.includes('&lt;b&gt;'));

console.log(`\nfinance-test: ${passed} OK, ${failed} fallos`);
process.exit(failed ? 1 : 0);
