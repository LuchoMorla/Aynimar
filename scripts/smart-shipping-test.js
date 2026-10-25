'use strict';
/* eslint-disable no-console */
/**
 * Smart Shipping, Fase B: cotizador + recálculo al confirmar (flag app_settings.smart_shipping).
 * Sin BD ni red externa: modelos y transacción sustituidos en memoria; servicio y rutas REALES.
 * Falla si: se acepta un precio del cliente, se reutiliza o vence una cotización, se aplica
 * la de otra orden, el total cobrado difiere del mostrado o el flag OFF cambia el flujo.
 * Usage: node scripts/smart-shipping-test.js
 */

Object.assign(process.env, {
  DATABASE_URL: 'postgres://shiptest:test@localhost:5432/shiptest_never_connects',
  JWT_SECRET:   'test-jwt-secret-only',
});
delete process.env.NODE_ENV;
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k === 'REDIS_URL') delete process.env[k];

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.log(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const crypto = require('crypto');
const sequelize = require('../libs/sequelize');
const { models } = sequelize;
const OrderService = require('../Services/orderService');
const automation = require('../Services/orderAutomationService');
const shipping = require('../Services/shippingQuoteService');
const adapters = require('../integrations/shipping/adapters');
const { computeOrderTotals, computeOrderTotalsWithShipping } = require('../Services/orderTotals');

// ── Estado en memoria ───────────────────────────────────────────────────────
const SETTINGS = {
  dropi_cities: JSON.stringify([{ id: 912, name: 'MACAS', departmentId: 50, department: 'MORONA SANTIAGO', stateCode: 'EC-S' }]),
};
const setFlag = (v) => { if (v) SETTINGS.smart_shipping = JSON.stringify(v); else delete SETTINGS.smart_shipping; };
const ON = { enabled: true, adapter: 'dropiTable', ttlMinutes: 15, policy: { mode: 'excess', multiplier: 1 } };

const PRODUCTS = { 101: { id: 101, name: 'Trapeador', price: 32.99, stock: null, isDeleted: false, dropiProductId: '112598' } };
let ORDERS, ITEMS, CUSTOMER_CITY;
const QUOTES = new Map();
const updates = [];       // ord.update(...) dentro de la txn
const rawQueries = [];    // UPDATE orders SET shipping_* ...
function reset() {
  ORDERS = {
    12: { id: 12, customerId: 20, state: 'carrito', stateOrder: null, confirmedAt: null, attribution: null },
    13: { id: 13, customerId: 20, state: 'carrito', stateOrder: null, confirmedAt: null, attribution: null },
  };
  ITEMS = { 12: [{ productId: 101, amount: 1, selectedDropiId: null }], 13: [{ productId: 101, amount: 1, selectedDropiId: null }] };
  CUSTOMER_CITY = 'Macas';
  updates.length = 0; rawQueries.length = 0; QUOTES.clear();
}
const lastUpdate = (id) => Object.assign({}, ...updates.filter((u) => u.id === id).map((u) => u.ch));
reset();
const inst = (o) => Object.assign(o, { async update(ch) { Object.assign(o, ch); updates.push({ id: o.id, ch: { ...ch } }); return o; } });

models.AppSetting.findOne = async ({ where }) => (SETTINGS[where.key] != null ? { value: SETTINGS[where.key] } : null);
models.Order.findByPk = async (id) => (ORDERS[id] ? inst(ORDERS[id]) : null);
models.Customer.findByPk = async (id) => (Number(id) === 20 ? { id: 20, userId: 2, city: CUSTOMER_CITY, user: {} } : null);
models.OrderProduct.findAll = async ({ where }) => (ITEMS[where.orderId] || []).map((i) => ({ ...i }));
models.Product.findAll = async ({ where }) => [].concat(where.id).map((id) => PRODUCTS[id]).filter(Boolean).map((p) => inst({ ...p }));
models.Product.findByPk = async (id) => (PRODUCTS[id] ? inst({ ...PRODUCTS[id] }) : null);
models.ShippingQuote.create = async (d) => { const q = inst({ id: crypto.randomUUID(), usedAt: null, ...JSON.parse(JSON.stringify(d)), expiresAt: d.expiresAt }); QUOTES.set(q.id, q); return q; };
models.ShippingQuote.findByPk = async (id) => QUOTES.get(id) || null;
models.ShippingQuote.findOne = async ({ where }) => [...QUOTES.values()].find((q) => q.orderId === where.orderId && q.usedAt) || null;
models.Order.sequelize.query = async (sql, opts) => { rawQueries.push({ sql, ...opts.replacements }); return [[], 0]; };
sequelize.transaction = async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } });
OrderService.prototype.findOne = async (id) => ({ ...ORDERS[id] });
OrderService.prototype._dispatchOrder = async () => ({ status: 'stub' });
OrderService.prototype._notifyOrderConfirmed = async () => {};
OrderService.prototype._ensureTrackingToken = async () => 'TOKEN';
automation.notifyOwnerNewOrder = () => {};

async function main() {
  console.log('\n▶ Puras: política y totales');
  const pol = { mode: 'excess', multiplier: 1 };
  assert('excedente 8,36 − 6,05 = 2,31', shipping.surchargeFor({ cost: 8.36, included: 6.05 }, pol) === 2.31);
  assert('opción más barata que la provisión → 0 (nunca negativo)', shipping.surchargeFor({ cost: 4.90, included: 6.05 }, pol) === 0);
  assert('absorb → 0', shipping.surchargeFor({ cost: 8.36, included: 6.05 }, { mode: 'absorb', multiplier: 1 }) === 0);
  assert('multiplier 1,15 → 2,66 (al céntimo hacia arriba)', shipping.surchargeFor({ cost: 8.36, included: 6.05 }, { mode: 'excess', multiplier: 1.15 }) === 2.66);
  const t0 = computeOrderTotalsWithShipping([{ price: 32.99, qty: 1 }], 2.31);
  assert('total = subtotal + recargo; subtotal solo productos', t0.subtotal === 32.99 && t0.total === 35.3, JSON.stringify(t0));
  assert('recargo 0 → idéntico a computeOrderTotals', JSON.stringify(computeOrderTotalsWithShipping([{ price: 32.99, qty: 2 }], 0)) === JSON.stringify(computeOrderTotals([{ price: 32.99, qty: 2 }])));
  const quito = adapters.dropiTable({ items: [{ dropiId: '112598' }], cityId: 802, cod: true });
  assert('tabla semilla Quito COD: Veloces 6,05 / Servientrega 7,01 / Laar 7,01', quito.find((o) => o.carrierId === 3)?.cost === 6.05 && quito.length === 3);
  assert('Macas: Veloces sin cobertura → no aparece', !adapters.dropiTable({ items: [{ dropiId: '112598' }], cityId: 912, cod: true }).some((o) => o.carrierId === 3));
  assert('producto fuera de la tabla → sin opciones', adapters.dropiTable({ items: [{ dropiId: '999' }], cityId: 802, cod: true }).length === 0);
  assert('dropiLive es un stub (pendiente Dropi)', (() => { try { adapters.dropiLive(); return false; } catch { return true; } })());

  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', require('../routes/orderRouter'));
  app.use('/api/v1/shipping', require('../routes/shippingRouter'));
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const tok = (sub) => jwt.sign({ sub, role: 'customer' }, process.env.JWT_SECRET);
  const post = async (path, body, sub = 2) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${tok(sub)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* texto */ }
    return { status: r.status, body: json, text };
  };
  const quote = (orderId = 12, extra = {}) => post('/shipping/quotes', { orderId, city: 'Macas', department: 'Morona Santiago', paymentMethod: 'cod', ...extra });
  const origError = console.error;
  console.error = () => {}; // logErrors imprime los 4xx esperados

  try {
    console.log('\n▶ Flag OFF: el flujo actual no cambia');
    setFlag(null);
    const off = await quote();
    assert('cotizar → 200 {enabled:false, fallback:"A coordinar"} sin guardar nada', off.status === 200 && off.body.enabled === false && off.body.fallback === 'A coordinar' && QUOTES.size === 0, off.text);
    const cod = await post('/orders/12/confirm-cod', { quoteId: crypto.randomUUID(), optionId: 'c1' });
    const ch = lastUpdate(12);
    const expected = { state: 'pendiente_envio', paymentMethod: 'cod', paymentStatus: 'pending', subtotal: 32.99, tax: 4.3, total: 32.99, fulfillmentStatus: 'PENDING_DISPATCH', fulfillmentRetryCount: 0, confirmedAt: 'DATE' };
    const got = { ...ch, confirmedAt: ch.confirmedAt instanceof Date ? 'DATE' : ch.confirmedAt };
    assert('confirm-cod → 200 con el mismo update de siempre (sin carrierName ni envío)', cod.status === 200 && JSON.stringify(got) === JSON.stringify(expected), `${cod.status} ${JSON.stringify(got)}`);
    assert('sin UPDATE de columnas shipping_* ni cotizaciones usadas', rawQueries.length === 0 && QUOTES.size === 0);
    assert('respuesta sin campos nuevos', cod.body && !('shippingCharge' in cod.body) && cod.body.total === 32.99, cod.text);
    reset();
    const ck = await post('/orders/checkout', { orderId: 12 });
    const ckCh = lastUpdate(12);
    assert('checkout OFF → total = subtotal, sin carrierName ni shippingCharge', ck.status === 200 && ckCh.total === 32.99 && !('carrierName' in ckCh) && !('shippingCharge' in ck.body) && rawQueries.length === 0, ck.text);
    reset();
    setFlag({ ...ON, enabled: 'true' });
    assert('enabled no booleano ("true") → apagado (fail-closed)', (await shipping.getConfig()).enabled === false);
    SETTINGS.smart_shipping = '{json roto';
    assert('JSON inválido → apagado', (await shipping.getConfig()).enabled === false);

    console.log('\n▶ Flag ON: cotizar');
    setFlag(ON);
    assert('precio del cliente en la cotización → 400', (await quote(12, { price: 0.01 })).status === 400);
    assert('método de pago inválido → 400', (await quote(12, { paymentMethod: 'tarjeta' })).status === 400);
    assert('orden ajena → 403', (await post('/shipping/quotes', { orderId: 12, city: 'Macas', paymentMethod: 'cod' }, 5)).status === 403);
    const unknownCity = await quote(12, { city: 'Atlantis' });
    assert('ciudad sin id Dropi → sin opciones + fallback', unknownCity.status === 200 && unknownCity.body.options.length === 0 && unknownCity.body.fallback === 'A coordinar');
    const q1 = await quote();
    const laar = q1.body.options?.find((o) => o.carrierId === 1);
    assert('Macas COD: opciones Laar y Servientrega (USD, eta null, quoteId, expiresAt ~15 min)',
      q1.status === 200 && q1.body.options.length === 2 && q1.body.currency === 'USD' && laar.currency === 'USD' && laar.eta === null && q1.body.quoteId
      && Math.abs(new Date(q1.body.expiresAt) - Date.now() - 15 * 60000) < 5000, q1.text);
    assert('Laar: precio 8,36, recargo 2,31, total 35,30', laar.quotedPrice === 8.36 && laar.surcharge === 2.31 && laar.total === 35.3, JSON.stringify(laar));

    console.log('\n▶ Flag ON: confirmar (recálculo en servidor)');
    const noQ = await post('/orders/12/confirm-cod', {});
    assert('sin cotización y CON cobertura → 409 SHIPPING_QUOTE_REQUIRED (sin confirmar)', noQ.status === 409 && noQ.body.code === 'SHIPPING_QUOTE_REQUIRED' && ORDERS[12].state === 'carrito', noQ.text);
    assert('recargo enviado por el cliente → 400 (Joi)', (await post('/orders/12/confirm-cod', { quoteId: q1.body.quoteId, optionId: 'c1', surcharge: 0 })).status === 400);
    const q13 = await quote(13);
    const foreign = await post('/orders/12/confirm-cod', { quoteId: q13.body.quoteId, optionId: 'c1' });
    assert('cotización de otra orden → 409', foreign.status === 409 && foreign.body.code === 'SHIPPING_QUOTE_INVALID', foreign.text);
    CUSTOMER_CITY = 'Quito';
    const cityMis = await post('/orders/12/confirm-cod', { quoteId: q1.body.quoteId, optionId: 'c1' });
    assert('ciudad de entrega ≠ cotizada → 409', cityMis.status === 409 && cityMis.body.code === 'SHIPPING_CITY_MISMATCH', cityMis.text);
    CUSTOMER_CITY = 'Macas';
    ITEMS[12][0].amount = 2;
    const changed = await post('/orders/12/confirm-cod', { quoteId: q1.body.quoteId, optionId: 'c1' });
    assert('carrito cambiado tras cotizar (huella) → 409', changed.status === 409 && changed.body.code === 'SHIPPING_CHANGED', changed.text);
    ITEMS[12][0].amount = 1;
    SETTINGS.shipping_rates = JSON.stringify({ ...adapters.SEED_RATES, products: { 112598: { included: 6.05, cities: { 912: { cod: { 1: 9.5, 2: 8.45 } } } } } });
    const ratesUp = await post('/orders/12/confirm-cod', { quoteId: q1.body.quoteId, optionId: 'c1' });
    assert('tarifa subió entre cotizar y confirmar → 409 (nunca se cobra más de lo mostrado)', ratesUp.status === 409 && ratesUp.body.code === 'SHIPPING_CHANGED', ratesUp.text);
    delete SETTINGS.shipping_rates;
    assert('ningún intento fallido marcó la cotización como usada', QUOTES.get(q1.body.quoteId).usedAt == null);

    updates.length = 0;
    const ok = await post('/orders/12/confirm-cod', { quoteId: q1.body.quoteId, optionId: 'c1' });
    const okCh = lastUpdate(12);
    assert('confirmación válida → 200; total cobrado = total mostrado (35,30)', ok.status === 200 && okCh.total === laar.total && ok.body.total === laar.total, `${ok.status} ${JSON.stringify(okCh)}`);
    assert('subtotal 32,99 + IVA extraído del total; carrierName LaarCourier', okCh.subtotal === 32.99 && okCh.tax === 4.6 && okCh.carrierName === 'LaarCourier', JSON.stringify(okCh));
    const rq = rawQueries[0] || {};
    assert('orders.shipping_* persistidos (charge 2,31, coste 8,36, carrier 1)', rq.ch === 2.31 && rq.cost === 8.36 && rq.c === 1 && rq.q === q1.body.quoteId, JSON.stringify(rq));
    assert('cotización marcada como usada', QUOTES.get(q1.body.quoteId).usedAt instanceof Date);

    ORDERS[12].state = 'carrito'; // aunque el carrito volviera a abrirse
    const reuse = await post('/orders/12/confirm-cod', { quoteId: q1.body.quoteId, optionId: 'c1' });
    assert('reutilizar la cotización → 409', reuse.status === 409 && reuse.body.code === 'SHIPPING_QUOTE_USED', reuse.text);

    const q2 = await quote();
    QUOTES.get(q2.body.quoteId).expiresAt = new Date(Date.now() - 1000);
    const exp = await post('/orders/12/confirm-cod', { quoteId: q2.body.quoteId, optionId: 'c2' });
    assert('cotización vencida → 409', exp.status === 409 && exp.body.code === 'SHIPPING_QUOTE_EXPIRED', exp.text);

    console.log('\n▶ Flag ON: sin cotización y sin cobertura → flujo actual sin recargo');
    reset();
    CUSTOMER_CITY = 'Atlantis'; // ciudad sin id Dropi
    const fb = await post('/orders/12/confirm-cod', {});
    const fbCh = lastUpdate(12);
    assert('confirm-cod → 200, total = subtotal, sin carrierName ni columnas shipping_*', fb.status === 200 && fbCh.total === 32.99 && !('carrierName' in fbCh) && rawQueries.length === 0 && fb.body.total === 32.99, `${fb.text} ${JSON.stringify(fbCh)}`);
    reset();
    PRODUCTS[101].dropiProductId = '999'; // producto sin tarifa en la tabla
    const fb2 = await post('/orders/12/confirm-cod', {});
    assert('producto sin tarifa → 200 sin recargo', fb2.status === 200 && lastUpdate(12).total === 32.99 && rawQueries.length === 0, fb2.text);
    PRODUCTS[101].dropiProductId = '112598';
    reset();
    const fb3 = await post('/orders/checkout', { orderId: 12 }); // DeUna en Macas: la semilla no tiene tarifa sin recaudo
    assert('checkout sin cotización y sin tarifa del método → 200 sin recargo', fb3.status === 200 && lastUpdate(12).total === 32.99 && !('shippingCharge' in fb3.body), fb3.text);

    console.log('\n▶ Flag ON: checkout (DeUna) y política');
    reset();
    const qd = await quote(12, { paymentMethod: 'deuna' });
    // Sin tarifa «sin recaudo» para Macas en la semilla → fallback; se usa el mock.
    assert('sin tarifa para el método → fallback, no se adivina', qd.body.options.length === 0 && qd.body.fallback === 'A coordinar', qd.text);
    setFlag({ ...ON, adapter: 'mock' });
    const qm = await quote(12, { paymentMethod: 'deuna' });
    const serv = qm.body.options.find((o) => o.optionId === 'c2'); // mock: coste 7,25, provisión 6 → recargo 1,25
    const ckOn = await post('/orders/checkout', { orderId: 12, quoteId: qm.body.quoteId, optionId: 'c2' });
    const ckOnCh = lastUpdate(12);
    assert('checkout DeUna: total = mostrado (subtotal + 1,25)', ckOn.status === 200 && serv.surcharge === 1.25 && ckOnCh.total === serv.total && ckOn.body.amountToPay === serv.total && ckOn.body.shippingCharge === 1.25, `${ckOn.text} ${JSON.stringify(ckOnCh)}`);
    updates.length = 0;
    const codAfter = await post('/orders/12/confirm-cod', {});
    assert('créditos parciales + COD con cotización DeUna → 409', codAfter.status === 409 && codAfter.body.code === 'SHIPPING_QUOTE_INVALID', codAfter.text);
    reset();
    setFlag({ ...ON, policy: { mode: 'absorb' } });
    const qa = await quote();
    assert('política absorb → todos los recargos 0', qa.body.options.length > 0 && qa.body.options.every((o) => o.surcharge === 0 && o.total === 32.99), qa.text);
    process.env.NODE_ENV = 'production';
    setFlag(ON);
    const prod = await quote();
    assert('producción sin app_settings.shipping_rates → la semilla NO se usa (fallback)', prod.body.options.length === 0 && prod.body.fallback === 'A coordinar', prod.text);
    delete process.env.NODE_ENV;
  } finally {
    console.error = origError;
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
