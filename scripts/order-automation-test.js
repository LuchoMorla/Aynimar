'use strict';
/* eslint-disable no-console */
/**
 * Order Automation Test Suite — despacho idempotente a Dropi + excepciones + COD.
 *
 * Parte A (siempre, sin BD): mapa de estados reales de Dropi, teléfono EC, contrato
 *   y clasificación de errores del adaptador (fetch interceptado: nunca sale a Dropi).
 * Parte B (solo con ORDERS_TEST_DATABASE_URL): Postgres REAL en un schema temporal
 *   order_test_<pid> (search_path) que se borra al terminar. Aborta si el host parece
 *   producción (roundhouse*) o no es staging/local. Dropi SIEMPRE simulado.
 *
 * Usage: ORDERS_TEST_DATABASE_URL=postgres://… node scripts/order-automation-test.js
 */

for (const k of Object.keys(process.env)) {
  if (/^(TELEGRAM_|RAILWAY_|DROPI_|ORDER_)/.test(k) && k !== 'ORDERS_TEST_DATABASE_URL') delete process.env[k];
  if (k === 'REDIS_URL') delete process.env[k];
}
const FAKE = { BOT: '222222:FAKE-bot-token-tests-only', SECRET: 'order_test-SECRET_xyz', ADMIN: '123456789' };
Object.assign(process.env, {
  JWT_SECRET: 'test-jwt-secret-only',
  NODE_ENV: 'test',
  DROPI_MOCK: 'true',
  DROPI_RETRY_WORKER_AUTOSTART: 'false',
  TELEGRAM_BOT_TOKEN: FAKE.BOT, TELEGRAM_NONPROD_BOT_ID: '222222', TELEGRAM_CHAT_ID: FAKE.ADMIN,
  TELEGRAM_WEBHOOK_SECRET: FAKE.SECRET, RAILWAY_ENVIRONMENT_NAME: 'staging',
});

const logs = [];
const out = (...a) => console._log(...a);
for (const level of ['log', 'warn', 'error', 'info']) {
  console[`_${level}`] = console[level];
  console[level] = (...args) => logs.push(args.map(String).join(' '));
}
let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { out(`  ✅ ${label}`); passed++; } else { console._error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── Red falsa: Telegram registrado, Dropi bajo control del test, resto bloqueado ──
const realFetch = global.fetch;
const tg = [];
let dropiHttp = null; // (url, opts) => respuesta simulada para el adaptador "real"
const jsonResp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.telegram.org') {
    tg.push({ method: u.pathname.split('/').pop(), body: opts.body ? JSON.parse(opts.body) : null });
    return jsonResp(200, { ok: true, result: { message_id: tg.length } });
  }
  if (u.hostname === 'dropi.test' && dropiHttp) return dropiHttp(u, opts);
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  throw Object.assign(new Error(`red real bloqueada en tests: ${u.hostname}`), { code: 'ECONNREFUSED' });
};

// Módulos con efectos de red sustituidos ANTES de cargar el servicio.
const path = require('path');
const stub = (rel, exp) => { const p = require.resolve(path.join(__dirname, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const mails = [];
stub('../utils/sendMail', async (m) => { mails.push(m.to); });
stub('../libs/cartRecoveryQueue', { cartRecoveryQueue: { add: async () => {}, getJob: async () => null }, connection: {}, queueConnection: {} });

// ── Parte A ──────────────────────────────────────────────────────────────────
async function partA() {
  out('\n▶ A1. Estados reales de Dropi (list_statuses 2026-10-20) → grupo interno');
  const auto = require('../Services/orderAutomationService');
  const m = auto.mapDropiStatus;
  assert('ENTREGADO → delivered', m('ENTREGADO') === 'delivered');
  assert('"EN TRÁNSITO" y la variante rota "EN TRNSITO" → transit', m('EN TRÁNSITO') === 'transit' && m('EN TRNSITO') === 'transit');
  assert('"ENVÍO LISTO EN OFICINA\\r\\n" (con salto) → transit', m('ENVÍO LISTO EN OFICINA\r\n') === 'transit');
  assert('RECHAZADO → rejected; DEVOLUCION → returned; CANCELADO → cancelled', m('RECHAZADO') === 'rejected' && m('DEVOLUCION') === 'returned' && m('CANCELADO') === 'cancelled');
  assert('NOVEDAD → issue', m('NOVEDAD') === 'issue' && m('CON NOVEDAD') === 'issue');
  assert('"DEVOLUCIÓN / ENTREGA" (ambiguo) y uno inventado → unknown', m('DEVOLUCIÓN / ENTREGA') === 'unknown' && m('ESTADO RARO') === 'unknown');

  out('\n▶ A2. Teléfono Ecuador');
  const p = auto.normalizePhoneEC;
  assert('+593 99 123 4567 → 0991234567', p('+593 99 123 4567') === '0991234567');
  assert('991234567 → 0991234567', p('991234567') === '0991234567');
  assert('basura → null', p('12345') === null && p('') === null);

  out('\n▶ A3. Configuración por defecto (interruptor apagado, pisos configurables)');
  const cfg = auto.getConfig({});
  assert('DROPI_ORDER_AUTOMATION por defecto = off', cfg.mode === 'off');
  assert('pilotFloor = USD 1 · autoFloor = USD 5 y 15 %', cfg.pilotFloor.minContribution === 1 && cfg.autoFloor.minContribution === 5 && cfg.autoFloor.minMarginOnNet === 0.15);
  assert('valor inválido → off (fail-closed)', auto.getConfig({ DROPI_ORDER_AUTOMATION: 'yes' }).mode === 'off');
  assert('pisos sobreescribibles por env', auto.getConfig({ ORDER_PILOT_MIN_CONTRIBUTION_USD: '2.5' }).pilotFloor.minContribution === 2.5);

  out('\n▶ A4. Adaptador real (red simulada): contrato oficial y errores ambiguos');
  const adPath = require.resolve('../integrations/dropi/dropiAdapter');
  delete require.cache[adPath];
  process.env.DROPI_MOCK = 'false';
  const real = require('../integrations/dropi/dropiAdapter');
  delete require.cache[adPath];
  const payload = { shopOrderId: 'AYNIMAR-1', rateType: 'CON RECAUDO', codAmount: 20, customer: { name: 'A', surname: 'B', dir: 'Calle 1', state: 'PICHINCHA', city: 'QUITO', phone: '0991234567' }, products: [{ id: 5, price: 20, quantity: 1, variation_id: 9 }] };
  let mockSent = 0;
  dropiHttp = async () => { mockSent++; return jsonResp(200, {}); };
  const viaMock = await real.createOrderInDropi(payload);
  assert('transporte por defecto = mock (sin red, id MOCK-DRP)', real.orderTransportName() === 'mock' && /^MOCK-DRP-/.test(viaMock.externalOrderId) && mockSent === 0);
  process.env.DROPI_ORDER_TRANSPORT = 'http';
  let e = await real.createOrderInDropi(payload).catch((x) => x);
  assert('http sin DROPI_ORDER_API_URL/TOKEN → error DEFINITIVO (no se llamó a Dropi)', e instanceof Error && !e.ambiguous && mockSent === 0);
  process.env.DROPI_ORDER_API_URL = 'https://dropi.test/orders';
  process.env.DROPI_ORDER_TOKEN = 'FAKE-order-token';
  let sent = null;
  dropiHttp = async (u, o) => { sent = JSON.parse(o.body); return jsonResp(200, { isSuccess: true, objects: { id: 777 } }); };
  const ok = await real.createOrderInDropi(payload);
  assert('2xx con id → externalOrderId', ok.externalOrderId === '777');
  assert('cuerpo = contrato oficial (rate_type, products[].variation_id, shop_order_id)', sent.rate_type === 'CON RECAUDO' && sent.products[0].variation_id === 9 && sent.shop_order_id === 'AYNIMAR-1' && sent.city === 'QUITO');
  dropiHttp = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  e = await real.createOrderInDropi(payload).catch((x) => x);
  assert('timeout → ambiguous=true', e.ambiguous === true);
  dropiHttp = async () => jsonResp(502, {});
  e = await real.createOrderInDropi(payload).catch((x) => x);
  assert('HTTP 502 → ambiguous=true', e.ambiguous === true);
  dropiHttp = async () => jsonResp(422, { message: 'ciudad inválida' });
  e = await real.createOrderInDropi(payload).catch((x) => x);
  assert('HTTP 422 → definitivo (ambiguous=false)', e.ambiguous === false);
  dropiHttp = async () => jsonResp(200, { isSuccess: true });
  e = await real.createOrderInDropi(payload).catch((x) => x);
  assert('2xx SIN id → ambiguous=true', e.ambiguous === true);
  dropiHttp = async () => jsonResp(200, { objects: { id: 777, status: 'GUIA_GENERADA', shipping_guide: 'G-1' } });
  const st = await real.fetchDropiOrderStatus('777');
  assert('estado vía http → {status, trackingNumber}', st?.status === 'GUIA_GENERADA' && st.trackingNumber === 'G-1');
  process.env.DROPI_MOCK = 'true';
  assert('DROPI_MOCK=true fuerza mock aunque DROPI_ORDER_TRANSPORT=http', real.orderTransportName() === 'mock');
  delete process.env.DROPI_ORDER_API_URL; delete process.env.DROPI_ORDER_TOKEN; delete process.env.DROPI_ORDER_TRANSPORT; dropiHttp = null;
}

// ── Parte B: Postgres real ───────────────────────────────────────────────────
async function setupDb() {
  const raw = process.env.ORDERS_TEST_DATABASE_URL;
  const host = new URL(raw).hostname;
  if (/^roundhouse/i.test(host)) { console._error('ABORT: el host parece PRODUCCIÓN'); process.exit(2); }
  if (!/^(altaria|localhost$|127\.0\.0\.1$)/.test(host)) { console._error('ABORT: host no reconocido como staging/local'); process.exit(2); }
  const schema = `order_test_${process.pid}`;
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw, ssl: false });
  await c.connect();
  await c.query(`CREATE SCHEMA "${schema}"`);
  await c.end();
  const u = new URL(raw);
  u.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = u.toString();
  return { raw, schema };
}
async function dropSchema(raw, schema) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw, ssl: false });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await c.end();
}

async function partB({ schema }) {
  const sequelize = require('../libs/sequelize');
  sequelize.options.logging = false;
  const { QueryTypes } = require('sequelize');
  const sel = (sql, r = {}) => sequelize.query(sql, { replacements: r, type: QueryTypes.SELECT });
  const { models } = sequelize;
  const qi = sequelize.getQueryInterface();
  const mig = require('../db/migrations/20261020000002-order-automation');

  out(`\n▶ B0. Esquema temporal ${schema} + migración aditiva/reversible`);
  const [{ sp }] = await sel('SELECT current_schema() AS sp');
  assert('conexión aislada en el schema temporal', sp === schema);
  // sync() comprueba la existencia en "public" por defecto: se fija el schema temporal en
  // cada modelo para que TODO (tablas y ENUM) se cree y consulte calificado en él.
  for (const m of Object.values(models)) { m._schema = schema; m.options.schema = schema; }
  for (const n of ['User', 'Customer', 'Category', 'BusinessOwner', 'Business', 'Product', 'Order', 'Debit', 'OrderProduct', 'AppSetting']) await models[n].sync();
  // La asociación legacy Debit↔OrderProduct (foreignKey 'orderId') hace que sync apunte
  // orders_products.order_id a debits; en la BD real (migraciones) apunta a orders.
  await sequelize.query('ALTER TABLE orders_products DROP CONSTRAINT IF EXISTS orders_products_order_id_fkey');
  await sequelize.query('ALTER TABLE orders_products ADD FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL');
  await mig.down(qi);
  const cols = async () => (await sel("SELECT column_name FROM information_schema.columns WHERE table_schema = :s AND table_name = 'orders'", { s: schema })).map((r) => r.column_name);
  assert('down quita columnas y tabla', !(await cols()).includes('is_test') && !(await sel("SELECT 1 FROM information_schema.tables WHERE table_schema = :s AND table_name = 'order_exceptions'", { s: schema })).length);
  await mig.up(qi); await mig.up(qi);
  assert('up (dos veces) crea columnas y order_exceptions', (await cols()).includes('dropi_status_history') && (await sel("SELECT 1 FROM information_schema.tables WHERE table_schema = :s AND table_name = 'order_exceptions'", { s: schema })).length === 1);

  // Dropi simulado bajo control del test.
  const dropi = require('../integrations/dropi/dropiAdapter');
  const calls = [];
  let behavior = 'ok';
  let statusFeed = {};
  dropi.createOrderInDropi = async (p) => {
    calls.push(p);
    if (behavior === 'timeout') throw Object.assign(new Error('Dropi create_order AbortError (resultado desconocido)'), { ambiguous: true });
    if (behavior === '4xx') throw Object.assign(new Error('Dropi create_order HTTP 422'), { ambiguous: false });
    if (behavior === 'slow') await new Promise((r) => setTimeout(r, 150));
    return { externalOrderId: `MOCK-DRP-T${calls.length}` };
  };
  dropi.fetchDropiOrderStatus = async (id) => statusFeed[id] ?? null;

  const OrderService = require('../Services/orderService');
  const auto = require('../Services/orderAutomationService');
  const worker = require('../workers/dropiRetryWorker');
  const svc = new OrderService();
  const env = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = String(v); } };

  // Datos base
  const cat = await models.Category.create({ name: 'Test', image: 'x' });
  let uSeq = 0;
  async function customer(over = {}) {
    uSeq++;
    const user = await models.User.create({ email: `c${uSeq}@cliente.ec`, password: 'x', role: 'customer' });
    return models.Customer.create({ name: 'Ana', lastName: 'Pérez', phone: '0991234567', city: 'Quito', province: 'Pichincha', streetAddress: 'Av. Amazonas N24-03', userId: user.id, ...over });
  }
  const P = (o) => models.Product.create({ name: 'Prod', image: 'x', description: 'd', categoryId: cat.id, stock: 100, price: 40, costPrice: 8, dropiProductId: '1001', ...o });
  const good = await P({});
  async function order(cust, lines, over = {}) {
    const o = await models.Order.create({ customerId: cust.id, ...over });
    for (const [prod, amount, extra] of lines) await models.OrderProduct.create({ orderId: o.id, productId: prod.id, amount, ...(extra || {}) });
    return o;
  }
  const reload = (id) => models.Order.findByPk(id);
  const exTypes = async (id, status = 'open') => (await sel('SELECT type FROM order_exceptions WHERE order_id = :id AND status = :status ORDER BY type', { id, status })).map((r) => r.type);

  out('\n▶ B1. Interruptor apagado (por defecto): nada sale hacia Dropi');
  env({ DROPI_ORDER_AUTOMATION: undefined });
  const c1 = await customer();
  const o1 = await order(c1, [[good, 1]]);
  await svc.confirmCod(o1.id, c1.userId);
  assert('confirmCod → AUTOMATION_OFF, 0 llamadas a Dropi', (await reload(o1.id)).fulfillmentStatus === 'AUTOMATION_OFF' && calls.length === 0);
  assert('pedido de staging marcado is_test (prueba ≠ real)', (await reload(o1.id)).isTest === true);

  out('\n▶ B2. Un pedido = una orden en Dropi; eventos repetidos no duplican');
  env({ DROPI_ORDER_AUTOMATION: 'auto', DROPI_ORDER_SUPERVISED_MIN: 0 });
  const c2 = await customer();
  const o2 = await order(c2, [[good, 2]]);
  await svc.confirmCod(o2.id, c2.userId);
  let r2 = await reload(o2.id);
  assert('confirmCod → DISPATCHED con id externo', r2.fulfillmentStatus === 'DISPATCHED' && r2.dropiOrderId === 'MOCK-DRP-T1', `${r2.fulfillmentStatus} ${r2.fulfillmentError}`);
  assert('payload: CON RECAUDO, cobrar = total, ciudad Dropi, shop_order_id', calls[0].rateType === 'CON RECAUDO' && calls[0].codAmount === 80 && calls[0].customer.city === 'QUITO' && calls[0].shopOrderId === `AYNIMAR-${o2.id}`);
  const dup2 = await svc.confirmCod(o2.id, c2.userId).catch((e) => e);
  await svc._dispatchOrder(await svc.findOne(o2.id));
  await worker.retryPendingDropiOrders();
  await svc.retryFulfillment(o2.id);
  assert('2ª confirmación → 409; reintento/worker/manual → sigue 1 llamada', dup2.output?.statusCode === 409 && calls.length === 1);
  assert('COD pendiente y eventos reales VALIDADO > ENVIADO_A_DROPI con fecha', r2.codStatus === 'pending' && (r2.dropiStatusHistory || []).map((h) => h.status).join('>') === 'VALIDADO>ENVIADO_A_DROPI');

  out('\n▶ B3. Concurrencia: dos despachos simultáneos → un solo envío');
  behavior = 'slow';
  const c3 = await customer();
  const o3 = await order(c3, [[good, 1]], { state: 'pendiente_envio', paymentMethod: 'cod', paymentStatus: 'pending', total: 40, subtotal: 40, fulfillmentStatus: 'PENDING_DISPATCH' });
  const before3 = calls.length;
  const [a, b] = await Promise.all([svc._dispatchOrder(await svc.findOne(o3.id)), svc._dispatchOrder(await svc.findOne(o3.id))]);
  assert('uno DISPATCHED y otro SKIPPED, 1 llamada', calls.length - before3 === 1 && [a.status, b.status].sort().join() === 'DISPATCHED,SKIPPED', `${a.status}/${b.status}`);
  behavior = 'ok';

  out('\n▶ B4. Fallo de red tras el envío → resultado desconocido, sin segundo despacho');
  behavior = 'timeout';
  const c4 = await customer();
  const o4 = await order(c4, [[good, 1]]);
  await svc.confirmCod(o4.id, c4.userId);
  behavior = 'ok';
  const n4 = calls.length;
  await worker.retryPendingDropiOrders();
  await svc._dispatchOrder(await svc.findOne(o4.id));
  const retry4 = await svc.retryFulfillment(o4.id).catch((e) => e);
  let r4 = await reload(o4.id);
  assert('DISPATCH_UNKNOWN + excepción dispatch_unknown + error registrado', r4.fulfillmentStatus === 'DISPATCH_UNKNOWN' && (await exTypes(o4.id)).includes('dispatch_unknown') && /desconocido/.test(r4.fulfillmentError || ''));
  assert('worker, _dispatchOrder y retry manual NO reenvían (409 en el manual)', calls.length === n4 && retry4.output?.statusCode === 409);
  const [ex4] = await sel("SELECT id FROM order_exceptions WHERE order_id = :id AND type = 'dispatch_unknown'", { id: o4.id });
  const link = await auto.resolveException(ex4.id, { resolution: 'link', dropiOrderId: 'DRP-REAL-44' }, 1);
  assert('resolver "link" con el id encontrado en Dropi → DISPATCHED sin llamar a Dropi', link.order.fulfillmentStatus === 'DISPATCHED' && link.order.dropiOrderId === 'DRP-REAL-44' && calls.length === n4);
  const again = await auto.resolveException(ex4.id, { resolution: 'link', dropiOrderId: 'X' }, 1).catch((e) => e);
  assert('resolver dos veces → 409', again.output?.statusCode === 409);
  // not_created: verificado que no existe → se reintenta UNA vez
  behavior = 'timeout';
  const c4b = await customer();
  const o4b = await order(c4b, [[good, 1]]);
  await svc.confirmCod(o4b.id, c4b.userId);
  behavior = 'ok';
  const [ex4b] = await sel("SELECT id FROM order_exceptions WHERE order_id = :id AND type = 'dispatch_unknown'", { id: o4b.id });
  const n4b = calls.length;
  const nc = await auto.resolveException(ex4b.id, { resolution: 'not_created' }, 1);
  assert('"not_created" → un reenvío y DISPATCHED', nc.order.fulfillmentStatus === 'DISPATCHED' && calls.length === n4b + 1);
  // Proceso muerto en SENDING
  const c4c = await customer();
  const o4c = await order(c4c, [[good, 1]], { state: 'pendiente_envio', paymentMethod: 'cod', total: 25, fulfillmentStatus: 'SENDING', dispatchStartedAt: new Date(Date.now() - 3600e3) });
  await worker.sweepStuckSending();
  assert('SENDING colgado → DISPATCH_UNKNOWN + excepción (nunca reintento ciego)', (await reload(o4c.id)).fulfillmentStatus === 'DISPATCH_UNKNOWN' && (await exTypes(o4c.id)).includes('dispatch_unknown'));

  out('\n▶ B5. Error definitivo del proveedor: reintentos acotados → excepción');
  behavior = '4xx';
  const c5 = await customer();
  const o5 = await order(c5, [[good, 1]]);
  const n5 = calls.length;
  await svc.confirmCod(o5.id, c5.userId);
  for (let i = 0; i < 5; i++) await worker.retryPendingDropiOrders();
  const r5 = await reload(o5.id);
  assert(`${OrderService.MAX_DISPATCH_ATTEMPTS} intentos exactos → FAILED + provider_error`, calls.length - n5 === OrderService.MAX_DISPATCH_ATTEMPTS && r5.fulfillmentStatus === 'FAILED_DROPI_FULFILLMENT' && (await exTypes(o5.id)).includes('provider_error'), `${calls.length - n5} ${r5.fulfillmentStatus}`);
  assert('error registrado en la orden y alerta por Telegram', /422/.test(r5.fulfillmentError || '') && tg.some((t) => /FALLO DROPI/.test(t.body?.text || '')));
  behavior = 'ok';

  out('\n▶ B6. Cada tipo de excepción bloquea el envío (sin sustituir productos ni precios)');
  async function blocked(label, cust, lines, type, over) {
    const o = await order(cust, lines, over);
    const n = calls.length;
    if (over?.state) await svc._dispatchOrder(await svc.findOne(o.id)); else await svc.confirmCod(o.id, cust.userId);
    const r = await reload(o.id);
    const t = await exTypes(o.id);
    assert(`${label} → BLOCKED + ${type}, 0 llamadas`, r.fulfillmentStatus === 'BLOCKED' && t.includes(type) && calls.length === n, `${r.fulfillmentStatus} [${t}]`);
    return o;
  }
  await blocked('sin ID Dropi', await customer(), [[await P({ dropiProductId: null }), 1]], 'missing_dropi_id');
  const variant = await P({ dropiItems: [{ id: '501', value: 'Azul' }, { id: '502', value: 'Rojo' }] });
  await blocked('variante no elegida (no usa la 1ª)', await customer(), [[variant, 1]], 'variant_mismatch');
  await blocked('variante inexistente', await customer(), [[variant, 1, { selectedDropiId: '999' }]], 'variant_mismatch');
  const oVar = await order(await customer(), [[variant, 1, { selectedDropiId: '502' }]]);
  await svc.confirmCod(oVar.id, (await models.Customer.findByPk(oVar.customerId)).userId);
  assert('variante exacta → product id + variation_id', calls.at(-1).products[0].id === 1001 && calls.at(-1).products[0].variation_id === 502);
  await blocked('sin ciudad verificada', await customer({ city: 'Pueblo Desconocido' }), [[good, 1]], 'incomplete_address');
  await blocked('teléfono inválido', await customer({ phone: '123', phoneTwo: null }), [[good, 1]], 'incomplete_address');
  await blocked('margen insuficiente (coste alto)', await customer(), [[await P({ costPrice: 22 }), 1]], 'margin_insufficient');
  await blocked('coste desconocido', await customer(), [[await P({ costPrice: null }), 1]], 'margin_insufficient');
  await blocked('cantidad absurda', await customer(), [[good, 50]], 'inconsistent_data');
  const cd = await customer();
  await order(cd, [[good, 1]], { state: 'pendiente_envio', confirmedAt: new Date(), fulfillmentStatus: 'DISPATCHED' });
  await blocked('mismo cliente y productos en 24 h', cd, [[good, 1]], 'possible_duplicate');
  // Salud del catálogo: sin tabla → fallback; con issue abierto → bloquea
  assert('catalog_issues inexistente → fallback seguro (sin error)', (await auto.hasBlockingIssue(good.id)) === false);
  await sequelize.query(`CREATE TABLE catalog_issues (id SERIAL PRIMARY KEY, product_id INT NOT NULL, type VARCHAR(40) NOT NULL, severity VARCHAR(10) NOT NULL DEFAULT 'high', status VARCHAR(12) NOT NULL DEFAULT 'open')`);
  const oos = await P({});
  await sequelize.query("INSERT INTO catalog_issues (product_id, type) VALUES (:id, 'dropi_out_of_stock')", { replacements: { id: oos.id } });
  assert('hasBlockingIssue(productId) con issue abierto → true', (await auto.hasBlockingIssue(oos.id)) === true);
  const oOos = await blocked('agotado en Dropi (catalog_issues)', await customer(), [[oos, 1]], 'out_of_stock');
  const twice = await svc._dispatchOrder(await svc.findOne(oOos.id)).catch(() => null);
  assert('reevaluar no duplica la excepción', (await exTypes(oOos.id)).filter((t) => t === 'out_of_stock').length === 1 && twice?.status === 'SKIPPED');
  // Resolución "accept" de un margen: se envía saltándose solo ese tipo
  const oM = await blocked('margen bajo para aceptar', await customer(), [[await P({ costPrice: 21 }), 1]], 'margin_insufficient');
  const [exM] = await sel("SELECT id FROM order_exceptions WHERE order_id = :id AND type = 'margin_insufficient'", { id: oM.id });
  const acc = await auto.resolveException(exM.id, { resolution: 'accept', note: 'aprobado por el propietario' }, 1);
  assert('accept → se despacha (decisión humana registrada)', acc.order.fulfillmentStatus === 'DISPATCHED');
  const bad = await auto.resolveException(exM.id + 999, { resolution: 'retry' }, 1).catch((e) => e);
  assert('excepción inexistente → 404', bad.output?.statusCode === 404);

  out('\n▶ B7. Pisos de margen: piloto (≥ USD 1) vs automático (≥ USD 5 y 15 %)');
  const thin = await P({ price: 30, costPrice: 8 }); // contribución peor caso ≈ USD 3,8 (entre 1 y 5)
  const oT = await order(await customer(), [[thin, 1]], { state: 'pendiente_envio', paymentMethod: 'cod', paymentStatus: 'pending', total: 30, subtotal: 30, confirmedAt: new Date(), fulfillmentStatus: 'PENDING_DISPATCH' });
  const autoRes = await svc._dispatchOrder(await svc.findOne(oT.id));
  const det = (await sel("SELECT details FROM order_exceptions WHERE order_id = :id AND type = 'margin_insufficient'", { id: oT.id }))[0]?.details;
  assert('en automático: bloqueado por autoFloor', autoRes.status === 'BLOCKED' && det?.problems?.[0]?.floorName === 'autoFloor', JSON.stringify(det));
  env({ DROPI_ORDER_AUTOMATION: 'supervised' });
  const [exT] = await sel("SELECT id FROM order_exceptions WHERE order_id = :id AND type = 'margin_insufficient'", { id: oT.id });
  const supRes = await auto.resolveException(exT.id, { resolution: 'retry' }, 1);
  assert('en piloto supervisado: pasa el pilotFloor y espera confirmación', supRes.order.fulfillmentStatus === 'AWAITING_CONFIRMATION', supRes.order.fulfillmentStatus);

  out('\n▶ B8. Modo supervisado: botón firmado de Telegram');
  const prompt = tg.filter((t) => t.method === 'sendMessage' && /Ref: o\d+/.test(t.body?.text || '')).at(-1);
  const kb = prompt?.body?.reply_markup?.inline_keyboard?.[0] || [];
  const sec = require('../libs/telegramSecurity');
  const cqFor = (data) => ({ id: 'cq', from: { id: Number(FAKE.ADMIN) }, message: { message_id: 1, chat: { id: Number(FAKE.ADMIN) } }, data });
  const forged = sec.verifyCallbackQuery({ ...cqFor(kb[0]?.callback_data), from: { id: 1 } });
  assert('mensaje con botones firmados; un usuario ajeno es rechazado', kb.length === 2 && forged.ok === false);
  const v = sec.verifyCallbackQuery(cqFor(kb[0].callback_data));
  const nT = calls.length;
  const answers = [];
  const ans = async (id, text) => answers.push(text);
  const s1 = await auto.handleTelegramCallback(cqFor(kb[0].callback_data), v, ans);
  const s2 = await auto.handleTelegramCallback(cqFor(kb[0].callback_data), v, ans);
  assert('Enviar → DISPATCHED; doble clic no reenvía', s1.status === 'DISPATCHED' && s2.changed === false && calls.length === nT + 1);
  const cR = await customer();
  const oR = await order(cR, [[good, 1]]);
  await svc.confirmCod(oR.id, cR.userId);
  const vR = sec.verifyCallbackQuery(cqFor(sec.signCallbackData('rj', `o${oR.id}`)));
  await auto.handleTelegramCallback(cqFor(sec.signCallbackData('rj', `o${oR.id}`)), vR, ans);
  assert('Retener → BLOCKED + held_by_supervisor', (await reload(oR.id)).fulfillmentStatus === 'BLOCKED' && (await exTypes(oR.id)).includes('held_by_supervisor'));
  env({ DROPI_ORDER_AUTOMATION: 'auto' });

  out('\n▶ B9. Prueba ≠ real con Dropi real');
  env({ DROPI_MOCK: 'false', DROPI_ORDER_TRANSPORT: 'http' });
  const cX = await customer();
  const oX = await order(cX, [[good, 1]]);
  const nX = calls.length;
  await svc.confirmCod(oX.id, cX.userId);
  assert('transporte http fuera de producción: pedido de prueba no se envía', (await reload(oX.id)).fulfillmentStatus === 'TEST_NOT_SENT' && calls.length === nX);
  // Producción con transporte mock: un pedido REAL no puede quedar "enviado" con id simulado.
  env({ DROPI_MOCK: 'true', DROPI_ORDER_TRANSPORT: undefined, RAILWAY_ENVIRONMENT_NAME: 'production' });
  const cP = await customer();
  const oP = await order(cP, [[good, 1]]);
  await svc.confirmCod(oP.id, cP.userId);
  const rP = await reload(oP.id);
  assert('producción + mock + pedido real → BLOCKED + provider_error, 0 llamadas', rP.fulfillmentStatus === 'BLOCKED' && rP.isTest === false && !rP.dropiOrderId && (await exTypes(oP.id)).includes('provider_error') && calls.length === nX, `${rP.fulfillmentStatus} ${rP.dropiOrderId}`);
  env({ RAILWAY_ENVIRONMENT_NAME: 'staging' });

  out('\n▶ B10. Estados: transiciones coherentes; rechazada ≠ cobrada');
  const sync = async (id, status) => { const o = await reload(id); statusFeed[o.dropiOrderId] = { status }; return svc.syncDropiDeliveryStatus(id); };
  await sync(o2.id, 'GUIA_GENERADA');
  await sync(o2.id, 'EN TRÁNSITO');
  await sync(o2.id, 'GUIA_GENERADA'); // fuera de orden
  r2 = await reload(o2.id);
  assert('preparación → tránsito; un estado anterior no retrocede', r2.stateOrder === 'en_transito');
  await sync(o2.id, 'ENTREGADO');
  r2 = await reload(o2.id);
  assert('ENTREGADO → entregado, COD pending_settlement (NO cobrado) + cod_unreconciled', r2.stateOrder === 'entregado' && r2.codStatus === 'pending_settlement' && r2.paymentStatus === 'pending' && (await exTypes(o2.id)).includes('cod_unreconciled'));
  await sync(o2.id, 'DEVOLUCION');
  assert('terminal → otro terminal: no cambia y abre unknown_status', (await reload(o2.id)).stateOrder === 'entregado' && (await exTypes(o2.id)).includes('unknown_status'));
  assert('fechas por estado guardadas', (await reload(o2.id)).dropiStatusHistory.map((h) => h.status).join('>') === 'VALIDADO>ENVIADO_A_DROPI>GUIA_GENERADA>EN TRÁNSITO>GUIA_GENERADA>ENTREGADO>DEVOLUCION');
  const [exC] = await sel("SELECT id FROM order_exceptions WHERE order_id = :id AND type = 'cod_unreconciled'", { id: o2.id });
  const noAmt = await auto.resolveException(exC.id, { resolution: 'collected' }, 1).catch((e) => e);
  assert('conciliar sin importe → 400', noAmt.output?.statusCode === 400);
  const col = await auto.resolveException(exC.id, { resolution: 'collected', amount: 80, shippingCost: 4.5, providerFees: 1.2 }, 1);
  const rc = await reload(o2.id);
  assert('cobrado conciliado → paid + costes registrados', col.order.paymentStatus === 'paid' && rc.codStatus === 'collected' && Number(rc.shippingCost) === 4.5 && Number(rc.providerFees) === 1.2);
  // Rechazada
  const o3r = await reload(o3.id);
  statusFeed[o3r.dropiOrderId] = { status: 'RECHAZADO' };
  await svc.syncDropiDeliveryStatus(o3.id);
  const r3 = await reload(o3.id);
  assert('RECHAZADO → cancelado, COD not_collected, pago failed', r3.stateOrder === 'cancelado' && r3.codStatus === 'not_collected' && r3.paymentStatus === 'failed');
  await auto.openException(o3.id, 'cod_unreconciled', { manual: true });
  const [exR] = await sel("SELECT id FROM order_exceptions WHERE order_id = :id AND type = 'cod_unreconciled' AND status = 'open'", { id: o3.id });
  const cheat = await auto.resolveException(exR.id, { resolution: 'collected', amount: 25 }, 1).catch((e) => e);
  assert('marcar cobrada una orden rechazada → 409', cheat.output?.statusCode === 409 && (await reload(o3.id)).paymentStatus === 'failed');
  statusFeed[(await reload(o4.id)).dropiOrderId] = { status: 'NOVEDAD' };
  await svc.syncDropiDeliveryStatus(o4.id);
  statusFeed[(await reload(oVar.id)).dropiOrderId] = { status: 'ESTADO INVENTADO' };
  await svc.syncDropiDeliveryStatus(oVar.id);
  assert('NOVEDAD → delivery_issue; estado desconocido → unknown_status', (await exTypes(o4.id)).includes('delivery_issue') && (await exTypes(oVar.id)).includes('unknown_status'));
  const polled = await worker.syncDispatchedStatuses();
  assert('sondeo del worker recorre los despachados no terminales', polled >= 1);

  out('\n▶ B12. Doble disparo concurrente de la confirmación');
  const cD = await customer();
  const oD = await order(cD, [[good, 1]]);
  const nD = calls.length;
  const both = await Promise.allSettled([svc.confirmCod(oD.id, cD.userId), svc.confirmCod(oD.id, cD.userId)]);
  const rej = both.filter((x) => x.status === 'rejected');
  assert('dos confirmCod simultáneos → uno OK, otro 409, 1 sola llamada a Dropi', rej.length === 1 && rej[0].reason?.output?.statusCode === 409 && calls.length === nD + 1 && (await reload(oD.id)).fulfillmentStatus === 'DISPATCHED', `${both.map((x) => x.status)} ${calls.length - nD}`);

  out('\n▶ B13. Importe inconsistente entre tienda y orden → bloqueo');
  const cI = await customer();
  const oI = await order(cI, [[good, 1]], { state: 'pendiente_envio', paymentMethod: 'cod', paymentStatus: 'pending', total: 55, subtotal: 55, confirmedAt: new Date(), fulfillmentStatus: 'PENDING_DISPATCH' });
  const nI = calls.length;
  const rI = await svc._dispatchOrder(await svc.findOne(oI.id));
  assert('total ≠ líneas → BLOCKED + inconsistent_data, 0 llamadas', rI.status === 'BLOCKED' && (await exTypes(oI.id)).includes('inconsistent_data') && calls.length === nI);

  out('\n▶ B14. Cancelación: detiene el envío o abre excepción si Dropi ya la tiene');
  env({ DROPI_ORDER_AUTOMATION: 'supervised' });
  const cK = await customer();
  const oK = await order(cK, [[good, 1]]);
  await svc.confirmCod(oK.id, cK.userId);
  assert('supervisado: queda AWAITING_CONFIRMATION', (await reload(oK.id)).fulfillmentStatus === 'AWAITING_CONFIRMATION');
  const nK = calls.length;
  await svc.update(oK.id, { stateOrder: 'cancelado' }, 'admin');
  const vK = sec.verifyCallbackQuery(cqFor(sec.signCallbackData('ap', `o${oK.id}`)));
  const lateApprove = await auto.handleTelegramCallback(cqFor(sec.signCallbackData('ap', `o${oK.id}`)), vK, ans);
  const reK = await svc._dispatchOrder(await svc.findOne(oK.id));
  const rK = await reload(oK.id);
  assert('cancelada antes de enviar → CANCELLED; "Enviar" tardío y reintento no envían', rK.fulfillmentStatus === 'CANCELLED' && lateApprove.changed === false && reK.status === 'SKIPPED' && calls.length === nK);
  assert('COD cancelado → not_collected / failed (nunca cobrado)', rK.codStatus === 'not_collected' && rK.paymentStatus === 'failed');
  // Cancelado justo antes del claim: el claim pierde aunque el estado de envío siga pendiente.
  const oK2 = await order(await customer(), [[good, 1]], { state: 'pendiente_envio', stateOrder: 'cancelado', paymentMethod: 'cod', paymentStatus: 'pending', total: 40, subtotal: 40, fulfillmentStatus: 'CONFIRMED' });
  const reK2 = await svc._dispatchOrder(await svc.findOne(oK2.id));
  assert('orden cancelada en CONFIRMED → no se envía', ['CANCELLED', 'SKIPPED'].includes(reK2.status) && calls.length === nK);
  env({ DROPI_ORDER_AUTOMATION: 'auto' });
  const cA = await customer();
  const oA = await order(cA, [[good, 1]]);
  await svc.confirmCod(oA.id, cA.userId);
  await svc.update(oA.id, { stateOrder: 'cancelado' }, 'admin');
  const rA = await reload(oA.id);
  assert('cancelada tras enviarse → excepción cancelled_after_dispatch, COD not_collected', rA.fulfillmentStatus === 'DISPATCHED' && (await exTypes(oA.id)).includes('cancelled_after_dispatch') && rA.codStatus === 'not_collected' && tg.some((t) => /cancelado tras enviarse/.test(t.body?.text || '')));
  const [exA] = await sel("SELECT id FROM order_exceptions WHERE order_id = :id AND type = 'cancelled_after_dispatch'", { id: oA.id });
  const retryA = await auto.resolveException(exA.id, { resolution: 'retry' }, 1).catch((e) => e);
  const accA = await auto.resolveException(exA.id, { resolution: 'accept', note: 'anulada en Dropi' }, 1);
  assert('no se puede "retry"; "accept" la cierra sin tocar el envío', retryA.output?.statusCode === 400 && accA.order.fulfillmentStatus === 'DISPATCHED' && calls.length === nK + 1);

  out('\n▶ B15. Devolución: en tránsito de vuelta → devuelto; nunca cobrado');
  const cR2 = await customer();
  const oRv = await order(cR2, [[good, 1]]);
  await svc.confirmCod(oRv.id, cR2.userId);
  await sync(oRv.id, 'EN TRÁNSITO');
  await sync(oRv.id, 'DEVOLUCION EN TRANSITO');
  assert('DEVOLUCION EN TRANSITO → por_devolver', (await reload(oRv.id)).stateOrder === 'por_devolver');
  await sync(oRv.id, 'DEVOLUCION');
  const rRv = await reload(oRv.id);
  assert('DEVOLUCION → devuelto, COD not_collected, pago failed', rRv.stateOrder === 'devuelto' && rRv.codStatus === 'not_collected' && rRv.paymentStatus === 'failed');
  await sync(oRv.id, 'ENTREGADO');
  assert('devuelto → ENTREGADO: no cambia (unknown_status), sigue sin cobrar', (await reload(oRv.id)).stateOrder === 'devuelto' && (await reload(oRv.id)).paymentStatus === 'failed' && (await exTypes(oRv.id)).includes('unknown_status'));

  out('\n▶ B11. API /api/v1/order-exceptions (JWT + admin)');
  const express = require('express');
  require('../utils/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/order-exceptions', require('../routes/orderExceptionsRouter'));
  // Igual que middlewares/errorsHandler (boom → su status; resto → 500), sin cargar Sentry.
  app.use((err, req, res, next) => (err.isBoom ? res.status(err.output.statusCode).json(err.output.payload) : res.status(500).json({ message: err.message }))); // eslint-disable-line no-unused-vars
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/order-exceptions`;
  const jwt = require('jsonwebtoken');
  const tok = (role) => jwt.sign({ sub: 1, role }, process.env.JWT_SECRET);
  const call = async (url, { method = 'GET', token, body } = {}) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    assert('sin token → 401', (await call(base)).status === 401);
    assert('cliente → 403', (await call(base, { token: tok('customer') })).status === 403);
    const list = await call(`${base}?type=out_of_stock`, { token: tok('admin') });
    assert('admin → 200 con items y modo', list.status === 200 && list.json.items.length >= 1 && list.json.mode === 'auto');
    const row = list.json.items[0];
    assert('la lista no expone datos personales', !JSON.stringify(list.json).match(/Ana|Pérez|0991234567|Amazonas|@cliente/));
    assert('resolución inválida → 400', (await call(`${base}/${row.id}/resolve`, { method: 'POST', token: tok('admin'), body: { resolution: 'borrar' } })).status === 400);
    assert('resolución no admitida para el tipo → 400', (await call(`${base}/${row.id}/resolve`, { method: 'POST', token: tok('admin'), body: { resolution: 'collected', amount: 1 } })).status === 400);
    const ok = await call(`${base}/${row.id}/resolve`, { method: 'POST', token: tok('admin'), body: { resolution: 'manual', note: 'gestionado en el panel de Dropi' } });
    assert('resolve manual → 200 y MANUAL_DISPATCH', ok.status === 200 && ok.json.order.fulfillmentStatus === 'MANUAL_DISPATCH');
  } finally {
    server.close();
  }
  await sequelize.close();
}

(async () => {
  const db = process.env.ORDERS_TEST_DATABASE_URL ? await setupDb() : null;
  if (!db) process.env.DATABASE_URL = 'postgres://ordtest:test@localhost:5432/never_connects';
  try {
    await partA();
    if (db) await partB(db);
    else out('\n▶ Parte B (Postgres) OMITIDA: define ORDERS_TEST_DATABASE_URL (staging o local; nunca producción).');
  } catch (err) {
    failed++;
    console._error('ERROR NO CONTROLADO:', err.original?.message || '', err.stack);
    console._error(logs.slice(-15).join('\n'));
  } finally {
    if (db) await dropSchema(db.raw, db.schema).then(() => out(`\n(schema ${db.schema} eliminado)`)).catch((e) => console._error('no se pudo borrar el schema:', e.message));
  }
  out(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
