'use strict';
/* eslint-disable no-console */
/**
 * Créditos / IDOR Security Test Suite
 *
 * Cero conexiones a BD: sequelize.query y los métodos de los modelos se
 * sustituyen por stubs. Levanta los routers reales en un puerto efímero local.
 * Falla si vuelve alguna vulnerabilidad de las auditorías ayni-play/02 y /03:
 *  - complete-challenge acredita créditos o confía en orderAmountUsd (R1/R2)
 *  - IDOR en recicladores, ofertas y wallets (R3/R4/R5)
 *  - POST /payments devuelve el Recycler en vez del Payment (R8)
 *  - POST /business-owner/by-user sin JWT o sobre otro usuario (03, crítico)
 *  - PATCH/DELETE /wastes/:id sobre residuos de otro negocio (03)
 *
 * Usage:
 *   node scripts/creditos-security-test.js
 *
 * Exit code 0 = all passed. Exit code 1 = at least one failure.
 */

const JWT_SECRET = 'test-jwt-secret-only';
Object.assign(process.env, {
  // Parseable para construir Sequelize; nunca se conecta (mismo patrón que telegram-security-test.js).
  DATABASE_URL: 'postgres://credtest:test@localhost:5432/credtest_never_connects',
  JWT_SECRET,
});

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

async function main() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const sequelize = require('../libs/sequelize');
  const { models } = sequelize;

  // ── Stub de SQL crudo: cada test fija la respuesta ─────────────────────────
  const sql = [];
  let sqlHandler = () => [[], 0];
  sequelize.query = async (q, opts = {}) => { sql.push(q); return sqlHandler(q, opts); };
  const OrderService = require('../Services/orderService');
  let ownsBusiness = false;
  OrderService.prototype.isBusinessOfOwner = async () => ownsBusiness;

  const spy = () => { const f = async (...a) => { f.calls.push(a); return f.ret; }; f.calls = []; return f; };

  // Sin alias `sequelize.sequelize`: si gamificationRouter vuelve a importar
  // `{ sequelize }` (undefined), sus rutas dan 500 y los asserts de abajo fallan.

  const { logErrors, ormErrorHandler, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const gamification = require('../routes/gamificationRouter');
  const app = express();
  app.use(express.json());
  app.use('/gamification', gamification);
  app.use('/recyclers', require('../routes/recyclerRouter'));
  app.use('/wallets', require('../routes/walletRouter'));
  app.use('/offers', require('../routes/offersRouting'));
  app.use('/payments', require('../routes/paymentRouter'));
  app.use('/business-owner', require('../routes/businessOwnerRouter'));
  app.use('/wastes', require('../routes/wasteRouter'));
  app.use(logErrors); app.use(ormErrorHandler); app.use(boomErrorHandler); app.use(errorHandler);
  const origError = console.error;
  console.error = (...a) => { if (!String(a[0]).includes('FAIL')) return; origError(...a); }; // silencia logErrors
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const tok = (sub, role) => jwt.sign({ sub, role }, JWT_SECRET);
  const CUST = tok(2, 'customer');
  const OWNER = tok(2, 'business_owner');
  const ADMIN = tok(1, 'admin');
  async function call(method, path, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  }

  // ── 1. complete-challenge (R1/R2) ──────────────────────────────────────────
  console.log('\n▶ complete-challenge no acredita créditos');
  assert('CHALLENGE_CREDITS_ENABLED está apagado', gamification.CHALLENGE_CREDITS_ENABLED === false);
  sql.length = 0;
  sqlHandler = () => []; // slug de plantilla sin fila en BD
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/gamification/complete-challenge', CUST, { slug: 'buy_75_boss', orderAmountUsd: 999999 });
    assert(`plantilla con monto inventado (#${i + 1}) → credited 0`, r.status === 200 && r.json.credited === 0, r.text);
  }
  assert('nunca se ejecuta UPDATE wallets', !sql.some((q) => /UPDATE\s+wallets/i.test(q)), sql.join(' | '));
  sqlHandler = (q) => (/^\s*SELECT/i.test(q) ? [{ id: 10, reward_credits: 50 }] : [[{ '?column?': 1 }], 1]);
  let r = await call('POST', '/gamification/complete-challenge', CUST, { slug: 'first_order' });
  assert('reto de BD sin completar → 200 credited 0', r.status === 200 && r.json.credited === 0, r.text);
  sqlHandler = (q) => (/^\s*SELECT/i.test(q) ? [{ id: 10, reward_credits: 50 }] : [[], 0]);
  r = await call('POST', '/gamification/complete-challenge', CUST, { slug: 'first_order' });
  assert('reto de BD ya completado → 409 (no vuelve a contar)', r.status === 409, r.text);
  sqlHandler = () => [];
  r = await call('POST', '/gamification/complete-challenge', CUST, { slug: 'no_existe' });
  assert('slug inexistente → 404', r.status === 404, r.text);
  sqlHandler = () => [];
  r = await call('GET', '/gamification/daily-challenges', CUST);
  assert('daily-challenges → 200 (import de sequelize correcto)', r.status === 200 && Array.isArray(r.json), r.text);
  assert('daily-challenges no promete créditos (rewardCredits 0)', Array.isArray(r.json) && r.json.length > 0 && r.json.every((c) => c.rewardCredits === 0), r.text);

  // ── 2. Recicladores (R3) ───────────────────────────────────────────────────
  console.log('\n▶ IDOR recicladores');
  const recUpdate = spy(); const recDestroy = spy();
  models.Recycler.findByPk = async (id) => ({ id: Number(id), userId: 3, identityNumber: 'CEDULA-AJENA', update: recUpdate, destroy: recDestroy, toJSON() { return { id: this.id, userId: 3, identityNumber: 'CEDULA-AJENA' }; } });
  r = await call('GET', '/recyclers/5', CUST);
  assert('GET perfil ajeno → 404 sin datos', r.status === 404 && !r.text.includes('CEDULA-AJENA'), r.text);
  r = await call('PATCH', '/recyclers/5', CUST, { bank: 'X' });
  assert('PATCH perfil ajeno → 404 y no actualiza', r.status === 404 && recUpdate.calls.length === 0, r.text);
  r = await call('DELETE', '/recyclers/5', CUST);
  assert('DELETE perfil ajeno → 404 y no borra', r.status === 404 && recDestroy.calls.length === 0, r.text);
  r = await call('PATCH', '/recyclers/5', tok(3, 'recycler'), { userId: 2 });
  assert('PATCH con userId (reasignar perfil) → 400', r.status === 400 && recUpdate.calls.length === 0, r.text);
  r = await call('GET', '/recyclers/5', tok(3, 'recycler'));
  assert('GET perfil propio → 200', r.status === 200, r.text);
  r = await call('GET', '/recyclers/5', ADMIN);
  assert('GET admin → 200', r.status === 200, r.text);

  // ── 3. Wallets (R5) ────────────────────────────────────────────────────────
  console.log('\n▶ IDOR wallets');
  models.Wallet.findByPk = async () => ({ id: 7, userId: 3, credit: 40, user: { email: 'ajeno@example.test' } });
  r = await call('GET', '/wallets/7', CUST);
  assert('GET wallet ajena → 404 sin correo', r.status === 404 && !r.text.includes('ajeno@example.test'), r.text);
  r = await call('GET', '/wallets/7', tok(3, 'customer'));
  assert('GET wallet propia → 200', r.status === 200, r.text);
  r = await call('GET', '/wallets/7', ADMIN);
  assert('GET wallet admin → 200', r.status === 200, r.text);

  // ── 4. Ofertas (R4) ────────────────────────────────────────────────────────
  console.log('\n▶ IDOR ofertas');
  const offUpdate = spy(); const offDestroy = spy();
  models.Offers.findByPk = async () => ({ id: 1, paymentId: 4, status: 'pending', update: offUpdate, destroy: offDestroy });
  models.PaymentWaste.findOne = async () => null;
  sqlHandler = () => [[], 0]; // el negocio del dueño no está en la oferta
  r = await call('GET', '/offers/1', OWNER);
  assert('GET oferta de otro negocio → 404', r.status === 404, r.text);
  r = await call('PATCH', '/offers/1', OWNER, { status: 'accepted' });
  assert('PATCH oferta de otro negocio → 404 y no cambia', r.status === 404 && offUpdate.calls.length === 0, r.text);
  r = await call('DELETE', '/offers/1', OWNER);
  assert('DELETE oferta de otro negocio → 404 y no borra', r.status === 404 && offDestroy.calls.length === 0, r.text);
  ownsBusiness = false;
  r = await call('GET', '/offers/by-business/9', OWNER);
  assert('GET by-business de otro negocio → 404', r.status === 404, r.text);
  sqlHandler = () => [[{ '?column?': 1 }], 1];
  r = await call('PATCH', '/offers/1', OWNER, { paymentId: 99 });
  assert('PATCH paymentId (reapuntar oferta) → 400', r.status === 400 && offUpdate.calls.length === 0, r.text);
  r = await call('PATCH', '/offers/1', OWNER, { status: 'accepted' });
  assert('PATCH oferta propia → 200', r.status === 200 && offUpdate.calls.length === 1, r.text);

  // ── 5. POST /payments primer intento (R8) ──────────────────────────────────
  console.log('\n▶ Primer POST /payments de un customer');
  let hasRecycler = false;
  models.Recycler.findOne = async () => (hasRecycler ? { id: 77, userId: 2 } : null);
  models.Customer.findOne = async () => ({ dataValues: { name: 'A', lastName: 'B', phone: '1', userId: 2 } });
  models.Recycler.create = async (d) => { hasRecycler = true; return { id: 77, ...d }; };
  models.Payment.create = async (d) => ({ id: 500, ...d });
  r = await call('POST', '/payments', CUST, {});
  assert('devuelve el Payment (id de pago), no el Recycler', r.status === 201 && r.json.id === 500 && r.json.recyclerId === 77, r.text);

  // ── 6. POST /business-owner/by-user (03, crítico) ──────────────────────────
  console.log('\n▶ business-owner/by-user');
  const userUpdate = spy();
  let userRole = 'customer';
  models.User.findByPk = async (id) => ({ id: Number(id), role: userRole, update: userUpdate });
  const boCreate = spy();
  models.BusinessOwner.create = boCreate;
  const boBody = { name: 'N', lastName: 'L', identityNumber: '1', userId: 3 };
  r = await call('POST', '/business-owner/by-user', null, boBody);
  assert('sin JWT → 401 y no toca usuarios', r.status === 401 && userUpdate.calls.length === 0, r.text);
  r = await call('POST', '/business-owner/by-user', CUST, boBody);
  assert('userId ajeno → 403 y no toca usuarios', r.status === 403 && userUpdate.calls.length === 0, r.text);
  r = await call('POST', '/business-owner/by-user', CUST, { ...boBody, userId: 2 });
  const issued = r.json?.token ? jwt.verify(r.json.token, JWT_SECRET) : {};
  assert('propio → 201, JWT del propio usuario', r.status === 201 && issued.sub === 2 && boCreate.calls[0]?.[0].userId === 2, r.text);
  userRole = 'admin'; userUpdate.calls.length = 0;
  r = await call('POST', '/business-owner/by-user', ADMIN, { name: 'N', lastName: 'L', identityNumber: '1' });
  assert('admin no se degrada a business_owner', r.status === 201 && userUpdate.calls.length === 0, r.text);

  // ── 7. Residuos (03) ───────────────────────────────────────────────────────
  console.log('\n▶ IDOR residuos');
  const wUpdate = spy(); const wDestroy = spy();
  models.Waste.findByPk = async () => ({ id: 3, businessId: 12, update: wUpdate, destroy: wDestroy });
  ownsBusiness = false;
  r = await call('PATCH', '/wastes/3', OWNER, { price: 1 });
  assert('PATCH residuo de otro negocio → 404 y no cambia', r.status === 404 && wUpdate.calls.length === 0, r.text);
  r = await call('DELETE', '/wastes/3', OWNER);
  assert('DELETE residuo de otro negocio → 404 y no borra', r.status === 404 && wDestroy.calls.length === 0, r.text);
  ownsBusiness = true;
  r = await call('DELETE', '/wastes/3', OWNER);
  assert('DELETE residuo propio → OK', r.status === 201 && wDestroy.calls.length === 1, r.text);

  server.close();
  console.log(`\n${'─'.repeat(50)}\nCréditos security tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.log('Error inesperado en la suite:', err);
  process.exit(1);
});
