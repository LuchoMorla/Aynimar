'use strict';
/* eslint-disable no-console */
/**
 * IDOR de órdenes: GET/DELETE /orders/:id, GET /orders/userId/:id y las rutas
 * por :businessId. Sin BD: se sustituyen findOne / findByUser /
 * findOrdersByBusinessId / is*Owner del servicio real.
 * Usage: node scripts/order-idor-test.js
 */

Object.assign(process.env, {
  DATABASE_URL: 'postgres://idortest:test@localhost:5432/idortest_never_connects',
  JWT_SECRET:   'test-jwt-secret-only',
});
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k === 'REDIS_URL') delete process.env[k];

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const OrderService = require('../Services/orderService');
// Orden 10 del cliente con userId 2; orden 11 contiene productos del negocio del user 7.
const destroyed = [];
const ORDERS = {
  10: { id: 10, customer: { userId: 2 }, items: [] },
  11: { id: 11, customer: { userId: 3 }, items: [] },
};
OrderService.prototype.findOne = async (id) => {
  const o = ORDERS[id];
  return o ? { ...o, destroy: async () => { destroyed.push(o.id); } } : null;
};
OrderService.prototype.isOrderOfBusinessOwner = async (orderId, userId) => Number(orderId) === 11 && Number(userId) === 7;
// El negocio 4 es del user 7.
OrderService.prototype.isBusinessOfOwner = async (businessId, userId) => Number(businessId) === 4 && Number(userId) === 7;
OrderService.prototype.findByUser = async (userId) => Object.values(ORDERS).filter((o) => o.customer.userId === Number(userId));
OrderService.prototype.findOrdersByBusinessId = async (businessId) => (Number(businessId) === 4 ? [ORDERS[11]] : [ORDERS[10]]);

async function main() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const orderRouter = require('../routes/orderRouter');
  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', orderRouter);
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/orders`;
  const tok = (sub, role) => jwt.sign({ sub, role }, process.env.JWT_SECRET);
  const call = async (method, id, token) => {
    const r = await fetch(`${base}/${id}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: await r.text() };
  };
  const origError = console.error;
  console.error = () => {}; // logErrors imprime los 4xx esperados

  try {
    console.log('\n▶ GET /orders/:id');
    const own = await call('GET', 10, tok(2, 'customer'));
    assert('cliente dueño → 200', own.status === 200 && JSON.parse(own.body).id === 10, String(own.status));
    assert('cliente ajeno → 404', (await call('GET', 10, tok(5, 'customer'))).status === 404);
    assert('admin → 200', (await call('GET', 10, tok(1, 'admin'))).status === 200);
    assert('business_owner de un negocio de la orden → 200', (await call('GET', 11, tok(7, 'business_owner'))).status === 200);
    assert('business_owner ajeno → 404', (await call('GET', 10, tok(7, 'business_owner'))).status === 404);
    assert('orden inexistente → 404', (await call('GET', 999, tok(1, 'admin'))).status === 404);
    assert('sin JWT → 401', (await call('GET', 10)).status === 401);

    console.log('\n▶ DELETE /orders/:id');
    assert('customer (aunque sea dueño) → 403', (await call('DELETE', 10, tok(2, 'customer'))).status === 403);
    assert('recycler → 403', (await call('DELETE', 10, tok(2, 'recycler'))).status === 403);
    assert('business_owner sobre orden ajena → 404', (await call('DELETE', 10, tok(7, 'business_owner'))).status === 404);
    assert('nada borrado por los intentos anteriores', destroyed.length === 0);
    assert('business_owner sobre orden de su negocio → 201', (await call('DELETE', 11, tok(7, 'business_owner'))).status === 201 && destroyed.includes(11));
    assert('admin → 201', (await call('DELETE', 10, tok(1, 'admin'))).status === 201 && destroyed.includes(10));
    assert('admin sobre inexistente → 404 (antes 500)', (await call('DELETE', 999, tok(1, 'admin'))).status === 404);

    console.log('\n▶ GET /orders/userId/:id');
    const mine = await call('GET', 'userId/2', tok(2, 'customer'));
    assert('cliente, sus propios pedidos → 200', mine.status === 200 && JSON.parse(mine.body).length === 1, String(mine.status));
    const other = await call('GET', 'userId/2', tok(5, 'customer'));
    assert('cliente, pedidos de otro → 404 sin datos', other.status === 404 && !other.body.includes('userId'), String(other.status));
    assert('recycler, pedidos de otro → 404', (await call('GET', 'userId/2', tok(5, 'recycler'))).status === 404);
    assert('business_owner, pedidos de otro usuario → 404', (await call('GET', 'userId/2', tok(7, 'business_owner'))).status === 404);
    assert('admin, pedidos de cualquiera → 200', (await call('GET', 'userId/2', tok(1, 'admin'))).status === 200);
    assert('sin JWT → 401', (await call('GET', 'userId/2')).status === 401);

    console.log('\n▶ GET /orders/by/business/:businessId y verify-product-is-in-order-active');
    const ownBiz = await call('GET', 'by/business/4', tok(7, 'business_owner'));
    assert('business_owner, su negocio → 200', ownBiz.status === 200 && JSON.parse(ownBiz.body)[0].id === 11, String(ownBiz.status));
    const otherBiz = await call('GET', 'by/business/9', tok(7, 'business_owner'));
    assert('business_owner, negocio ajeno → 404 sin datos', otherBiz.status === 404 && !otherBiz.body.includes('userId'), String(otherBiz.status));
    assert('admin, cualquier negocio → 200', (await call('GET', 'by/business/9', tok(1, 'admin'))).status === 200);
    assert('customer → 403', (await call('GET', 'by/business/4', tok(2, 'customer'))).status === 403);
    assert('verify-product, negocio propio → 200', (await call('GET', 'verify-product-is-in-order-active/1/4', tok(7, 'business_owner'))).status === 200);
    assert('verify-product, negocio ajeno → 404', (await call('GET', 'verify-product-is-in-order-active/1/9', tok(7, 'business_owner'))).status === 404);
  } finally {
    console.error = origError;
    server.close();
  }
  console.log(`\n${'─'.repeat(50)}\nOrder IDOR tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('Error inesperado en la suite:', err); process.exit(1); });
