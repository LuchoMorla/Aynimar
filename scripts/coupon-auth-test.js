'use strict';
/* eslint-disable no-console */
/**
 * Auth de /coupons: create, toggle, delete y list exigen JWT (admin o
 * business_owner dueño del negocio); /validate sigue público.
 * Sin BD: se sustituyen models.Coupon.* y OrderService.isBusinessOfOwner.
 * Usage: node scripts/coupon-auth-test.js
 */

Object.assign(process.env, {
  DATABASE_URL: 'postgres://coupontest:test@localhost:5432/coupontest_never_connects',
  JWT_SECRET:   'test-jwt-secret-only',
});
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k === 'REDIS_URL') delete process.env[k];

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// El negocio 4 es del user 7. Cupón 30 del negocio 4; cupón 31 del negocio 9.
const OrderService = require('../Services/orderService');
OrderService.prototype.isBusinessOfOwner = async (businessId, userId) => Number(businessId) === 4 && Number(userId) === 7;

const { models } = require('../libs/sequelize');
const COUPONS = {
  30: { id: 30, businessId: 4, code: 'PROPIO', type: 'PERCENTAGE', value: '10', minOrderAmount: null, startDate: null, endDate: null, isActive: true },
  31: { id: 31, businessId: 9, code: 'AJENO', type: 'PERCENTAGE', value: '10', minOrderAmount: null, startDate: null, endDate: null, isActive: true },
};
const created = [], toggled = [], destroyed = [];
const wrap = (c) => ({
  ...c,
  update: async (patch) => { toggled.push(c.id); Object.assign(c, patch); },
  destroy: async () => { destroyed.push(c.id); },
  toJSON: () => c,
});
models.Coupon.findByPk = async (id) => (COUPONS[id] ? wrap(COUPONS[id]) : null);
models.Coupon.findAll = async ({ where }) => Object.values(COUPONS).filter((c) => c.businessId === where.businessId);
models.Coupon.findOne = async ({ where }) => {
  const c = Object.values(COUPONS).find((x) => x.code === where.code && (where.isActive === undefined || x.isActive === where.isActive)
    && (where.businessId === undefined || x.businessId === Number(where.businessId)));
  return c ? wrap(c) : null;
};
models.Coupon.create = async (data) => { created.push(data.businessId); return { id: 99, ...data }; };

async function main() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/coupons', require('../routes/couponRouter'));
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/coupons`;
  const tok = (sub, role) => jwt.sign({ sub, role }, process.env.JWT_SECRET);
  const call = async (method, path, token, body) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.text() };
  };
  const owner = tok(7, 'business_owner'), stranger = tok(8, 'business_owner'), admin = tok(1, 'admin');
  const newCoupon = (businessId) => ({ businessId, code: 'nuevo 100', type: 'PERCENTAGE', value: 100 });
  const origError = console.error;
  console.error = () => {}; // logErrors imprime los 4xx esperados

  try {
    console.log('\n▶ Anónimo → 401');
    assert('create → 401', (await call('POST', '', null, newCoupon(4))).status === 401);
    assert('toggle → 401', (await call('PATCH', '/30/toggle')).status === 401);
    assert('delete → 401', (await call('DELETE', '/30')).status === 401);
    assert('list → 401', (await call('GET', '/business/4')).status === 401);
    assert('nada creado/cambiado/borrado', !created.length && !toggled.length && !destroyed.length);

    console.log('\n▶ Rol sin permiso → 403');
    assert('customer create → 403', (await call('POST', '', tok(2, 'customer'), newCoupon(4))).status === 403);
    assert('customer list → 403', (await call('GET', '/business/4', tok(2, 'customer'))).status === 403);

    console.log('\n▶ business_owner de otro negocio → 404 (igual que inexistente)');
    const otherList = await call('GET', '/business/4', stranger);
    assert('list ajena → 404 sin datos', otherList.status === 404 && !otherList.body.includes('PROPIO'), String(otherList.status));
    assert('create en negocio ajeno → 404', (await call('POST', '', owner, newCoupon(9))).status === 404);
    const tAjeno = await call('PATCH', '/31/toggle', owner);
    const tNoExiste = await call('PATCH', '/999/toggle', owner);
    assert('toggle ajeno → 404', tAjeno.status === 404, String(tAjeno.status));
    assert('toggle ajeno idéntico a inexistente', tAjeno.body === tNoExiste.body && tNoExiste.status === 404);
    const dAjeno = await call('DELETE', '/31', owner);
    assert('delete ajeno → 404 idéntico a inexistente', dAjeno.status === 404 && dAjeno.body === (await call('DELETE', '/999', owner)).body);
    assert('nada creado/cambiado/borrado', !created.length && !toggled.length && !destroyed.length);

    console.log('\n▶ Dueño y admin → 2xx');
    const ownList = await call('GET', '/business/4', owner);
    assert('dueño list → 200', ownList.status === 200 && JSON.parse(ownList.body)[0].id === 30, String(ownList.status));
    const c = await call('POST', '', owner, newCoupon(4));
    assert('dueño create → 201 (código normalizado)', c.status === 201 && JSON.parse(c.body).code === 'NUEVO100', String(c.status));
    assert('dueño toggle → 200', (await call('PATCH', '/30/toggle', owner)).status === 200 && toggled.includes(30));
    assert('dueño delete → 200', (await call('DELETE', '/30', owner)).status === 200 && destroyed.includes(30));
    assert('admin list ajena → 200', (await call('GET', '/business/9', admin)).status === 200);
    assert('admin create → 201', (await call('POST', '', admin, newCoupon(9))).status === 201 && created.includes(9));
    assert('admin toggle → 200', (await call('PATCH', '/31/toggle', admin)).status === 200 && toggled.includes(31));
    assert('admin delete → 200', (await call('DELETE', '/31', admin)).status === 200 && destroyed.includes(31));
    assert('create sin body válido (dueño) → 400', (await call('POST', '', owner, { businessId: 4 })).status === 400);

    console.log('\n▶ /validate sigue público');
    COUPONS[30].isActive = true;
    const v = await call('POST', '/validate', null, { code: 'propio', cartTotal: 100, businessId: 4 });
    assert('anónimo, cupón válido → 200 con descuento', v.status === 200 && JSON.parse(v.body).discount === 10, `${v.status} ${v.body}`);
    assert('anónimo, código inexistente → 404', (await call('POST', '/validate', null, { code: 'NOPE', cartTotal: 100 })).status === 404);
    assert('anónimo, body inválido → 400', (await call('POST', '/validate', null, { code: 'X' })).status === 400);
  } finally {
    console.error = origError;
    server.close();
  }
  console.log(`\n${'─'.repeat(50)}\nCoupon auth tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('Error inesperado en la suite:', err); process.exit(1); });
