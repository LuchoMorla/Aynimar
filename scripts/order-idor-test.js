'use strict';
/* eslint-disable no-console */
/**
 * IDOR de órdenes: GET/DELETE /orders/:id, GET /orders/userId/:id y las rutas
 * por :businessId. Sin BD: se sustituyen findOne / findByUser /
 * findOrdersByBusinessId / is*Owner del servicio real.
 * Payments: GET /payments/:id, /payments/userId/:id y POST /payments/add-commodity
 * (se sustituye models.Payment.findByPk; findOne/findOneForUser son los reales).
 * trackingToken de POST /orders/:id/confirm-cod y /orders/checkout
 * (se sustituyen Order/Customer.findByPk, la transacción y _ensureTrackingToken).
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

// Pago 20 del recycler cuyo userId es 2; pago 21 sin recycler.
const { models } = require('../libs/sequelize');
const PAYMENTS = {
  20: { id: 20, recyclerId: 8, recycler: { userId: 2, user: { dataValues: { password: 'x' } } } },
  21: { id: 21, recyclerId: null, recycler: null },
};
models.Payment.findByPk = async (id) => (PAYMENTS[id] ? { ...PAYMENTS[id], dataValues: {} } : null);
const PaymentService = require('../Services/paymentService');
PaymentService.prototype.findByUser = async (userId) => Object.values(PAYMENTS).filter((p) => p.recycler?.userId === Number(userId));
const commodities = [];
PaymentService.prototype.addCommodity = async (data) => { commodities.push(data.paymentId); return { id: 1, ...data }; };

// confirm-cod / checkout: código REAL del servicio (guards de propiedad) sobre modelos
// y transacción sustituidos. La orden 12 es un carrito del customer 20 (userId 2).
const sequelize = require('../libs/sequelize');
sequelize.transaction = async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } });
models.Order.findByPk = async (id) => (Number(id) === 12 ? { id: 12, customerId: 20, state: 'carrito' } : null);
models.Customer.findByPk = async (id) => (Number(id) === 20 ? { id: 20, userId: 2 } : null);
const tokenCalls = [];
OrderService.prototype._ensureTrackingToken = async (o) => { tokenCalls.push(o.id); return 'TOKEN_SOLO_DEL_DUENO_XXXX'; };

async function main() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const orderRouter = require('../routes/orderRouter');
  // Se carga antes de levantar el servidor: tarda y el keep-alive del cliente caducaría.
  const aiRouter = require('../routes/aiRouter');
  const { executeTool } = aiRouter;
  const { models } = require('../libs/sequelize');
  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', orderRouter);
  app.use('/api/v1/payments', require('../routes/paymentRouter'));
  app.use('/api/v1/ai', aiRouter);
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/orders`;
  const tok = (sub, role) => jwt.sign({ sub, role }, process.env.JWT_SECRET);
  const call = async (method, id, token, body, url = base) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${url}/${id}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

    console.log('\n▶ NutrIA obtener_estado_orden (sin LLM)');
    const realFindByPk = models.Order.findByPk;
    models.Order.findByPk = async (id) => (ORDERS[id] ? { id: Number(id), state: 'enviado', stateOrder: 'x', trackingNumber: 'G1', carrierName: 'C', customer: ORDERS[id].customer } : null);
    const ask = (id, ctx) => executeTool('obtener_estado_orden', { orden_id: id }, [], {}, ctx);
    const nf = await ask(999, { userId: 1, role: 'admin' });
    // El dueño primero: deja el pedido 10 en caché para comprobar que no se filtra a otros.
    assert('dueño → datos', (await ask(10, { userId: 2, role: 'customer' })).guia === 'G1');
    assert('anónimo → «no encontrado» (con caché caliente)', JSON.stringify(await ask(10, {})) === JSON.stringify(nf));
    assert('otro usuario → «no encontrado» (con caché caliente)', JSON.stringify(await ask(10, { userId: 5, role: 'customer' })) === JSON.stringify(nf));
    assert('admin → datos', (await ask(10, { userId: 1, role: 'admin' })).guia === 'G1');
    assert('pedido de invitado (sin customer), cliente → «no encontrado»', JSON.stringify(await ask(10, { userId: 'x' })) === JSON.stringify(nf));
    models.Order.findByPk = realFindByPk; // el resto de la suite usa el real/sus propios stubs

    console.log('\n▶ NutrIA alertar_telegram escapa HTML');
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '123:test', TELEGRAM_NONPROD_BOT_ID: '123', TELEGRAM_CHAT_ID: '1' });
    const realFetch = global.fetch;
    let sentText = null;
    global.fetch = async (url, opts) => { sentText = JSON.parse(opts.body).text; return { json: async () => ({ ok: true }) }; };
    try {
      await executeTool('alertar_telegram', { tipo: 'venta', mensaje: 'Hola <a href="http://x">y</a> & <b>' }, [], {});
    } finally {
      global.fetch = realFetch;
      for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_NONPROD_BOT_ID', 'TELEGRAM_CHAT_ID']) delete process.env[k];
    }
    assert('texto del usuario escapado', sentText && sentText.includes('Hola &lt;a href="http://x"&gt;y&lt;/a&gt; &amp; &lt;b&gt;') && !sentText.includes('<a '), String(sentText));
    assert('formato propio intacto', sentText && sentText.includes('<b>OPORTUNIDAD DE VENTA</b>'));

    console.log('\n▶ NutrIA /nutria/chat tope de tamaño (hallazgo c, antes del LLM)');
    const ai = base.replace('/orders', '/ai');
    const big = await call('POST', 'nutria/chat', null, { message: 'x'.repeat(2001) }, ai);
    assert('message > 2000 caracteres → 400', big.status === 400, String(big.status));

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
    console.log('\n▶ Payments: GET /payments/:id, /payments/userId/:id, POST /payments/add-commodity');
    const pay = base.replace('/orders', '/payments');
    const pget = (id, token) => call('GET', id, token, null, pay);
    const ownPay = await pget(20, tok(2, 'recycler'));
    assert('dueño del pago → 200 sin password', ownPay.status === 200 && JSON.parse(ownPay.body).id === 20 && !ownPay.body.includes('password'), String(ownPay.status));
    const otherPay = await pget(20, tok(5, 'customer'));
    assert('pago ajeno → 404 sin datos', otherPay.status === 404 && !otherPay.body.includes('userId'), String(otherPay.status));
    assert('business_owner, pago ajeno → 404', (await pget(20, tok(7, 'business_owner'))).status === 404);
    assert('pago sin recycler, no admin → 404', (await pget(21, tok(2, 'recycler'))).status === 404);
    assert('admin → 200', (await pget(20, tok(1, 'admin'))).status === 200);
    assert('inexistente → 404 (antes 500)', (await pget(999, tok(1, 'admin'))).status === 404);
    assert('sin JWT → 401', (await pget(20)).status === 401);
    const ownList = await pget('userId/2', tok(2, 'recycler'));
    assert('userId propio → 200', ownList.status === 200 && JSON.parse(ownList.body).length === 1, String(ownList.status));
    assert('userId ajeno → 404', (await pget('userId/2', tok(5, 'customer'))).status === 404);
    assert('userId ajeno, admin → 200', (await pget('userId/2', tok(1, 'admin'))).status === 200);
    assert('userId no numérico → 400', (await pget('userId/abc', tok(1, 'admin'))).status === 400);
    const commodity = (paymentId, token) => call('POST', 'add-commodity', token, { paymentId, wasteId: 1, amount: 1 }, pay);
    assert('add-commodity a pago ajeno → 404', (await commodity(20, tok(5, 'customer'))).status === 404);
    assert('nada añadido por el intento ajeno', commodities.length === 0);
    assert('add-commodity a pago propio → 201', (await commodity(20, tok(2, 'customer'))).status === 201 && commodities.includes(20));
    console.log('\n▶ trackingToken en confirm-cod / checkout: un tercero no lo obtiene');
    const post = async (url, token, body = {}) => {
      const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.text() };
    };
    const cod = await post('/12/confirm-cod', tok(5, 'customer'));
    assert('confirm-cod de un tercero → 403 sin token', cod.status === 403 && !cod.body.includes('TOKEN_'), String(cod.status));
    const codAdmin = await post('/12/confirm-cod', tok(1, 'admin'));
    assert('confirm-cod de admin no dueño → 403 sin token', codAdmin.status === 403 && !codAdmin.body.includes('TOKEN_'), String(codAdmin.status));
    const chk = await post('/checkout', tok(5, 'customer'), { orderId: 12 });
    assert('checkout de un tercero → 403 sin token', chk.status === 403 && !chk.body.includes('TOKEN_'), String(chk.status));
    assert('no se generó ningún token para terceros', tokenCalls.length === 0);
  } finally {
    console.error = origError;
    server.close();
  }
  console.log(`\n${'─'.repeat(50)}\nOrder IDOR tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('Error inesperado en la suite:', err); process.exit(1); });
