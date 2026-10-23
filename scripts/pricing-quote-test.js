'use strict';
/* eslint-disable no-console */
/**
 * Cotización de precio (financeContribution.quotePrice + POST /api/v1/pricing/quote).
 * Casos = ops-ceo-cto/finanzas/formula_precio.py (r = 30 %, M = 30 %, IVA 15 %).
 * Sin BD ni red externa. Usage: node scripts/pricing-quote-test.js
 */

Object.assign(process.env, {
  DATABASE_URL: 'postgres://pricingtest:test@localhost:5432/pricingtest_never_connects',
  JWT_SECRET:   'test-jwt-secret-only',
});
for (const k of Object.keys(process.env)) {
  if (k.startsWith('TELEGRAM_') || k.startsWith('PRICING_') || k === 'REDIS_URL') delete process.env[k];
}

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const { quotePrice, getPricingPolicy, roundUp99 } = require('../Services/financeContribution');

console.log('\n▶ Política por defecto (CEO-008)');
const p = getPricingPolicy();
assert('M = 0,30, r = 0,30, IVA activo, comisión 0', p.targetMargin === 0.3 && p.rejectRate === 0.3 && p.vatOnSales === true && p.codCommission === 0, JSON.stringify(p));

console.log('\n▶ Redondeo X,99 (a_99 de formula_precio.py)');
assert('30,55 → 30,99', roundUp99(30.55) === 30.99);
assert('30,99 → 30,99 (no sube si ya es ,99)', roundUp99(30.99) === 30.99);
assert('31,00 → 31,99', roundUp99(31) === 31.99);

// [nombre, coste, flete, PVP actual, PVP mín. con IVA, ,99, margen a PVP actual] — tabla de formula_precio.py, r = 30 %
const CASES = [
  ['Trapeador 112598', 7.36, 6.05, 32.99, 30.55, 30.99, 0.352],
  ['Zapatero 133820', 18.50, 6.46, 50.99, 50.10, 50.99, 0.312],
  ['Lanzador', 5.75, 4.78, 27.99, 24.03, 24.99, 0.399],
];
for (const [name, coste, flete, pvp, min, rec, margin] of CASES) {
  console.log(`\n▶ ${name}`);
  const q = quotePrice({ coste, flete, pvp });
  // El pricingEngine redondea al céntimo HACIA ARRIBA el coste y el neto: nunca baja del piso exacto, como mucho +0,03.
  assert(`PVP mínimo ≥ ${min} y ≤ ${min} + 0,03`, q.minPvp >= min && q.minPvp <= min + 0.031, String(q.minPvp));
  assert(`PVP recomendado = ${rec}`, q.recommendedPvp === rec, String(q.recommendedPvp));
  assert(`margen real a ${pvp} ≈ ${margin * 100} %`, near(q.marginOnNet, margin, 0.0015), String(q.marginOnNet));
  assert('contribución por pedido > 0', q.contributionPerOrder > 0, String(q.contributionPerOrder));
  const atRec = quotePrice({ coste, flete });
  assert('sin pvp → evalúa el recomendado y su margen ≥ 30 %', atRec.evaluatedPvp === rec && atRec.marginOnNet >= 0.2995, JSON.stringify(atRec));
}

console.log('\n▶ Margen negativo detectado (PVP = coste)');
const neg = quotePrice({ coste: 12, flete: 6, pvp: 12 });
assert('margen < 0 y contribución < 0', neg.marginOnNet < 0 && neg.contributionPerOrder < 0, JSON.stringify(neg));

console.log('\n▶ Variables de entorno');
process.env.PRICING_VAT_ON_SALES = 'false';
const noVat = quotePrice({ coste: 7.36, flete: 6.05 });
assert('IVA desactivado → PVP mín. ≈ 26,57 (sin ×1,15)', near(noVat.minPvp, 26.57, 0.031) && noVat.policy.taxRate === 0, JSON.stringify(noVat));
delete process.env.PRICING_VAT_ON_SALES;
process.env.PRICING_TARGET_MARGIN = 'abc';
assert('valor inválido → default 0,30', getPricingPolicy().targetMargin === 0.3);
process.env.PRICING_TARGET_MARGIN = '0.4';
assert('PRICING_TARGET_MARGIN=0.4 → 0,40', getPricingPolicy().targetMargin === 0.4);
delete process.env.PRICING_TARGET_MARGIN;

async function http() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/pricing', require('../routes/pricingRouter'));
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/pricing/quote`;
  const tok = (sub, role) => jwt.sign({ sub, role }, process.env.JWT_SECRET);
  const call = async (token, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const origError = console.error;
  console.error = () => {};
  const res = {};
  try {
    const body = { coste: 7.36, flete: 6.05, pvp: 32.99 };
    res.anon = await call(null, body);
    res.customer = await call(tok(2, 'customer'), body);
    res.owner = await call(tok(3, 'business_owner'), body);
    res.bad = await call(tok(1, 'admin'), { coste: -1, flete: 'x' });
    res.missing = await call(tok(1, 'admin'), { coste: 7.36 });
    res.extra = await call(tok(1, 'admin'), { ...body, hack: 1 });
    res.ok = await call(tok(1, 'admin'), body);
    res.str = await call(tok(1, 'admin'), { coste: '7.36', flete: '6.05' });
  } finally {
    console.error = origError;
    server.close();
  }
  console.log('\n▶ POST /api/v1/pricing/quote');
  assert('anónimo → 401', res.anon.status === 401);
  assert('customer → 403', res.customer.status === 403);
  assert('business_owner → 403 (solo admin)', res.owner.status === 403);
  assert('coste negativo / flete no numérico → 400', res.bad.status === 400);
  assert('sin flete → 400', res.missing.status === 400);
  assert('campo desconocido → 400', res.extra.status === 400);
  assert('admin → 200 con recomendado 30,99 y margen ≈ 35,2 %', res.ok.status === 200 && res.ok.body.recommendedPvp === 30.99 && near(res.ok.body.marginOnNet, 0.352, 0.0015), JSON.stringify(res.ok.body));
  assert('números como texto se convierten (Joi)', res.str.status === 200 && res.str.body.recommendedPvp === 30.99, JSON.stringify(res.str.body));
}

http()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    console.log(`\npricing-quote-test: ${passed} OK, ${failed} fallos`);
    process.exit(failed ? 1 : 0);
  });
