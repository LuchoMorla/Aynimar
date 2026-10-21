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

  out('\n▶ A4. Transporte http OFICIAL Ecuador contra un servidor HTTP FALSO local (nunca sale a Dropi)');
  const http = require('http');
  const reqs = [];
  let reply = async () => [200, { isSuccess: true, message: 'ok', objects: { id: 9001 } }];
  const fake = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', (c) => { raw += c; });
    rq.on('end', async () => {
      reqs.push({ method: rq.method, url: rq.url, headers: rq.headers, body: raw ? JSON.parse(raw) : null });
      const [code, body] = await reply();
      if (rs.destroyed) return;
      rs.writeHead(code, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  const adPath = require.resolve('../integrations/dropi/dropiAdapter');
  delete require.cache[adPath];
  process.env.DROPI_MOCK = 'false';
  const real = require('../integrations/dropi/dropiAdapter');
  delete require.cache[adPath];
  const payload = (n) => ({ shopOrderId: `AYNIMAR-${n}`, rateType: 'CON RECAUDO', codAmount: 40, supplierId: 77,
    customer: { name: 'Ana', surname: 'Pérez', dir: 'Av. Amazonas N24-03', state: 'EC-P', city: 'QUITO', phone: '0991234567', email: 'ana@cliente.ec' },
    products: [{ id: 1001, name: 'Prod', price: 15, quantity: 2, variation_id: 55 }, { id: 1002, name: 'Otro', price: 10, quantity: 1 }] });

  const cfgOf = (o) => real.orderHttpConfig({ NODE_ENV: 'production', DROPI_ORDER_HTTP_ENABLED: 'true', DROPI_INTEGRATION_KEY: 'k', ...o });
  const def = cfgOf({});
  assert('host por defecto api.dropi.ec → https://api.dropi.ec/integrations/orders/myorders', def.ok && def.url === 'https://api.dropi.ec/integrations/orders/myorders');
  assert('host .co rechazado (api.dropi.co, https://api.dropi.co, app.dropi.co)', ['api.dropi.co', 'https://api.dropi.co', 'app.dropi.co'].every((h) => !cfgOf({ DROPI_ORDER_API_HOST: h }).ok && /Colombia/.test(cfgOf({ DROPI_ORDER_API_HOST: h }).error)));
  assert('antiguo /api/v1/orders rechazado (ruta en el host y DROPI_ORDER_API_URL)', !cfgOf({ DROPI_ORDER_API_HOST: 'https://api.dropi.ec/api/v1/orders' }).ok && /DROPI_ORDER_API_URL/.test(cfgOf({ DROPI_ORDER_API_URL: 'https://api.dropi.ec/api/v1/orders' }).error));
  assert('otro host o http plano rechazados', !cfgOf({ DROPI_ORDER_API_HOST: 'evil.example' }).ok && !cfgOf({ DROPI_ORDER_API_HOST: 'http://api.dropi.ec' }).ok);
  assert('127.0.0.1 solo con NODE_ENV=test', !cfgOf({ DROPI_ORDER_API_HOST: `http://127.0.0.1:${port}` }).ok && cfgOf({ NODE_ENV: 'test', DROPI_ORDER_API_HOST: `http://127.0.0.1:${port}` }).ok);
  const noKey = cfgOf({ DROPI_INTEGRATION_KEY: '', DROPI_ORDER_TOKEN: 'legacy', WOO_CONSUMER_SECRET: 'legacy' });
  assert('sin DROPI_INTEGRATION_KEY → deshabilitado (DROPI_ORDER_TOKEN / WOO_CONSUMER_SECRET NO sirven de respaldo)', !noKey.ok && /DROPI_INTEGRATION_KEY/.test(noKey.error) && !/legacy/.test(noKey.error));
  assert('sin DROPI_ORDER_HTTP_ENABLED=true → deshabilitado aunque haya token (CEO-004)', !cfgOf({ DROPI_ORDER_HTTP_ENABLED: undefined }).ok);

  const viaMock = await real.createOrderInDropi(payload(1));
  assert('transporte por defecto = mock (sin red, id MOCK-DRP)', real.orderTransportName() === 'mock' && /^MOCK-DRP-/.test(viaMock.externalOrderId) && reqs.length === 0);
  Object.assign(process.env, { DROPI_ORDER_TRANSPORT: 'http', DROPI_ORDER_API_HOST: `http://127.0.0.1:${port}`, DROPI_ORDER_TIMEOUT_MS: '10000', DROPI_ORDER_TOKEN: 'legacy', WOO_CONSUMER_SECRET: 'legacy' });
  let e = await real.createOrderInDropi(payload(2)).catch((x) => x);
  assert('http sin flag ni token → error DEFINITIVO, 0 peticiones', e instanceof Error && !e.ambiguous && reqs.length === 0 && real.orderTransportError() !== null);
  process.env.DROPI_ORDER_HTTP_ENABLED = 'true';
  e = await real.createOrderInDropi(payload(2)).catch((x) => x);
  assert('http con flag y sin DROPI_INTEGRATION_KEY → deshabilitado, 0 peticiones', /DROPI_INTEGRATION_KEY/.test(e.message) && !e.ambiguous && reqs.length === 0);
  delete process.env.DROPI_ORDER_TOKEN; delete process.env.WOO_CONSUMER_SECRET;
  process.env.DROPI_INTEGRATION_KEY = 'FAKE-integration-key';
  assert('configuración completa → orderTransportError() = null', real.orderTransportError() === null);

  const ok = await real.createOrderInDropi(payload(3));
  const r0 = reqs[0];
  assert('éxito: objects.id → externalOrderId', ok.externalOrderId === '9001' && reqs.length === 1);
  assert('POST /integrations/orders/myorders', r0.method === 'POST' && r0.url === '/integrations/orders/myorders');
  assert('cabecera dropi-integration-key correcta, sin Authorization', r0.headers['dropi-integration-key'] === 'FAKE-integration-key' && !r0.headers.authorization && /application\/json/.test(r0.headers['content-type']));
  const SNAPSHOT = {
    total_order: 40, notes: 'AYNIMAR-3', name: 'Ana', surname: 'Pérez', dir: 'Av. Amazonas N24-03', country: 'EC', state: 'EC-P', city: 'QUITO',
    phone: '0991234567', client_email: 'ana@cliente.ec', payment_method_id: 1, status: 'PENDIENTE CONFIRMACION', type: 'FINAL_ORDER', rate_type: 'CON RECAUDO',
    products: [
      { id: 1001, name: 'Prod', type: 'VARIABLE', user_id: 77, quantity: 2, price: 15, variation_id: 55 },
      { id: 1002, name: 'Otro', type: 'SIMPLE', user_id: 77, quantity: 1, price: 10 },
    ],
    calculate_costs_and_shiping: true, supplier_id: 77, shop_order_id: 'AYNIMAR-3', create_product_if_not_exist: false,
  };
  assert('cuerpo EXACTO (snapshot del contrato del plugin oficial)', JSON.stringify(r0.body) === JSON.stringify(SNAPSHOT), JSON.stringify(r0.body));
  assert('el token NO va en el cuerpo', !JSON.stringify(r0.body).includes('FAKE-integration-key'));
  const again = await real.createOrderInDropi(payload(3));
  assert('mismo shop_order_id tras éxito → mismo id, 0 peticiones nuevas', again.externalOrderId === '9001' && again.deduped === true && reqs.length === 1);

  reply = async () => [200, { isSuccess: true, objects: { id: 9100 } }];
  const nBefore = reqs.length;
  reply = async () => { await new Promise((r) => setTimeout(r, 100)); return [200, { isSuccess: true, objects: { id: 9100 } }]; };
  const [d1, d2] = await Promise.all([real.createOrderInDropi(payload(4)), real.createOrderInDropi(payload(4))]);
  assert('doble disparo simultáneo → 1 sola petición, mismo id', reqs.length === nBefore + 1 && d1.externalOrderId === '9100' && d2.externalOrderId === '9100');

  reply = async () => [200, { isSuccess: false, message: 'La ciudad no existe' }];
  e = await real.createOrderInDropi(payload(5)).catch((x) => x);
  assert('isSuccess=false → excepción con el mensaje, definitiva y sin reintento (permanent)', /La ciudad no existe/.test(e.message) && e.ambiguous === false && e.permanent === true);
  reply = async () => [422, { isSuccess: false, message: 'teléfono inválido' }];
  e = await real.createOrderInDropi(payload(6)).catch((x) => x);
  assert('HTTP 4xx → definitivo con el mensaje de Dropi', e.ambiguous === false && /422/.test(e.message) && /teléfono inválido/.test(e.message));
  const n6 = reqs.length;
  e = await real.createOrderInDropi(payload(6)).catch((x) => x);
  assert('tras un 4xx (no creada) el reintento acotado sí sale', reqs.length === n6 + 1);
  reply = async () => [503, {}];
  e = await real.createOrderInDropi(payload(7)).catch((x) => x);
  assert('HTTP 5xx → ambiguous=true (resultado desconocido)', e.ambiguous === true);
  reply = async () => [200, { isSuccess: true }];
  e = await real.createOrderInDropi(payload(8)).catch((x) => x);
  assert('2xx sin objects.id → ambiguous=true', e.ambiguous === true);

  process.env.DROPI_ORDER_TIMEOUT_MS = '500';
  reply = async () => { await new Promise((r) => setTimeout(r, 1500)); return [200, { isSuccess: true, objects: { id: 1 } }]; };
  const nT = reqs.length;
  e = await real.createOrderInDropi(payload(9)).catch((x) => x);
  assert('timeout → ambiguous=true (unknown)', e.ambiguous === true && /timeout/.test(e.message) && reqs.length === nT + 1, `${e.message} ${reqs.length - nT}`);
  e = await real.createOrderInDropi(payload(9)).catch((x) => x);
  assert('tras timeout NO se reintenta: 0 peticiones nuevas y error "revisión humana"', e.ambiguous === true && /revisión humana/.test(e.message) && reqs.length === nT + 1);
  real.releaseShopOrder('AYNIMAR-9');
  process.env.DROPI_ORDER_TIMEOUT_MS = '10000';
  reply = async () => [200, { isSuccess: true, objects: { id: 9900 } }];
  const after = await real.createOrderInDropi(payload(9));
  assert('solo tras not_created (releaseShopOrder) sale UNA vez más', after.externalOrderId === '9900' && reqs.length === nT + 2);
  assert('estado vía http → null (la API no documenta consulta de estado)', (await real.fetchDropiOrderStatus('9001')) === null);
  process.env.DROPI_MOCK = 'true';
  assert('DROPI_MOCK=true fuerza mock aunque DROPI_ORDER_TRANSPORT=http', real.orderTransportName() === 'mock');
  await new Promise((r) => setTimeout(r, 1600)); // deja cerrar la respuesta lenta pendiente
  fake.close();
  for (const k of ['DROPI_ORDER_TRANSPORT', 'DROPI_ORDER_API_HOST', 'DROPI_ORDER_TIMEOUT_MS', 'DROPI_ORDER_HTTP_ENABLED', 'DROPI_INTEGRATION_KEY']) delete process.env[k];

  out('\n▶ A6. Puerta previa sin BD (consultas simuladas): ciudades, proveedor, tope diario, flags, cancelación');
  const seqz = require('../libs/sequelize');
  const realQuery = seqz.query.bind(seqz);
  const appSettings = { dropi_suppliers: JSON.stringify({ 1001: 77 }) };
  let sentToday = 0;
  const opened = [];
  seqz.models.AppSetting.findOne = async ({ where }) => (appSettings[where.key] ? { value: appSettings[where.key] } : null);
  seqz.query = async (sql) => {
    if (/dispatch_started_at >= :since/.test(sql)) return [{ n: sentToday }];
    if (/count\(\*\)::int AS n FROM orders/.test(sql)) return [{ n: 0 }];
    if (/INSERT INTO order_exceptions/.test(sql)) { opened.push(sql); return [{ inserted: true }]; }
    return [];
  };
  const insertsOf = () => opened.length;
  const fakeOrder = (over = {}) => ({
    id: 501, isTest: false, customerId: null, paymentMethod: 'cod', paymentStatus: 'pending', total: 40, stateOrder: 'comprado_pendiente_pago',
    fulfillmentStatus: 'CONFIRMED', dropiStatusHistory: [{ status: 'VALIDADO', group: 'validated' }],
    customer: { name: 'Ana', lastName: 'Pérez', streetAddress: 'Av. Amazonas N24-03', phone: '0991234567', city: 'Quito', user: { email: 'ana@cliente.ec' } },
    items: [{ id: 1, name: 'Prod', dropiProductId: '1001', price: 40, costPrice: 8, OrderProduct: { amount: 1, unitPriceGross: 40 } }],
    async update(o) { Object.assign(this, o); return this; },
    ...over,
  });
  const ship = async (city, fmt) => { if (fmt) process.env.DROPI_ORDER_STATE_FORMAT = fmt; else delete process.env.DROPI_ORDER_STATE_FORMAT; return auto.buildShipping({ customer: { ...fakeOrder().customer, city } }); };
  let s = await ship('Quito');
  assert('Quito (802) → state EC-P (formato del plugin, por defecto), city QUITO', s.problems.length === 0 && s.shipping.state === 'EC-P' && s.shipping.city === 'QUITO' && s.shipping.cityId === 802);
  s = await ship('guayaquil', 'name');
  assert('Guayaquil (732) con DROPI_ORDER_STATE_FORMAT=name → GUAYAS', s.problems.length === 0 && s.shipping.state === 'GUAYAS' && s.shipping.cityId === 732);
  s = await ship('Cuenca');
  assert('ciudad no verificada (Cuenca) → bloqueo incomplete_address', s.problems[0]?.type === 'incomplete_address' && s.shipping.state === null);
  appSettings.dropi_cities = JSON.stringify([{ id: 999, name: 'CUENCA', department: 'AZUAY' }]);
  s = await ship('Cuenca');
  assert('ciudad añadida sin stateCode verificado → sigue bloqueada en formato code', s.problems[0]?.type === 'incomplete_address' && /stateCode/.test(JSON.stringify(s.problems)));
  delete appSettings.dropi_cities;

  assert('auto sin DROPI_ORDER_AUTO_ENABLED → supervised (CEO-004)', auto.getConfig({ DROPI_ORDER_AUTOMATION: 'auto' }).mode === 'supervised' && auto.getConfig({ DROPI_ORDER_AUTOMATION: 'auto', DROPI_ORDER_AUTO_ENABLED: 'true' }).mode === 'auto');
  assert('tope diario por defecto 5 y configurable', auto.getConfig({}).dailyCap === 5 && auto.getConfig({ ORDER_DAILY_DISPATCH_CAP: '2' }).dailyCap === 2);
  assert('día de Ecuador (UTC-5): 2026-10-20 03:00Z cuenta en el 19', auto.ecuadorDayStart(new Date('2026-10-20T03:00:00Z')).toISOString() === '2026-10-19T05:00:00.000Z');

  Object.assign(process.env, { RAILWAY_ENVIRONMENT_NAME: 'production', DROPI_MOCK: 'false', DROPI_ORDER_TRANSPORT: 'http', DROPI_ORDER_HTTP_ENABLED: 'true', DROPI_INTEGRATION_KEY: 'FAKE-integration-key' });
  const sup = auto.getConfig({ DROPI_ORDER_AUTOMATION: 'supervised' });
  sentToday = 4;
  let o = fakeOrder();
  let g = await auto.preDispatch(o, sup);
  assert('4 envíos reales hoy (tope 5) → se envía; payload con supplier 77 y state EC-P', g === null && o.__dropiPayload.supplierId === 77 && o.__dropiPayload.customer.state === 'EC-P');
  sentToday = 5;
  const nIns = insertsOf();
  o = fakeOrder();
  g = await auto.preDispatch(o, sup);
  assert('5 envíos reales hoy → BLOCKED + daily_cap_reached (en cola, no se descarta)', g?.status === 'BLOCKED' && g.problems.daily_cap_reached && o.fulfillmentStatus === 'BLOCKED' && insertsOf() === nIns + 1 && !o.__dropiPayload);
  sentToday = 0;
  o = fakeOrder({ customer: { ...fakeOrder().customer, city: 'Cuenca' } });
  g = await auto.preDispatch(o, sup);
  assert('ciudad fuera de Quito/Guayaquil → BLOCKED incomplete_address', g?.status === 'BLOCKED' && g.problems.incomplete_address);
  o = fakeOrder({ items: [{ ...fakeOrder().items[0], dropiProductId: '2002' }] });
  g = await auto.preDispatch(o, sup);
  assert('producto sin supplier_id verificado → BLOCKED missing_dropi_id', g?.status === 'BLOCKED' && /supplier_id/.test(JSON.stringify(g.problems.missing_dropi_id)));
  delete process.env.DROPI_INTEGRATION_KEY;
  o = fakeOrder();
  g = await auto.preDispatch(o, sup);
  assert('http sin DROPI_INTEGRATION_KEY → BLOCKED provider_error antes de validar/enviar', g?.status === 'BLOCKED' && !o.__dropiPayload && opened.length > 0);
  process.env.DROPI_INTEGRATION_KEY = 'FAKE-integration-key';
  process.env.DROPI_ORDER_API_HOST = 'api.dropi.co';
  o = fakeOrder();
  g = await auto.preDispatch(o, sup);
  assert('host .co → BLOCKED provider_error (no hay endpoints de Colombia)', g?.status === 'BLOCKED' && !o.__dropiPayload);
  for (const k of ['DROPI_ORDER_API_HOST', 'DROPI_ORDER_TRANSPORT', 'DROPI_ORDER_HTTP_ENABLED', 'DROPI_INTEGRATION_KEY']) delete process.env[k];
  Object.assign(process.env, { RAILWAY_ENVIRONMENT_NAME: 'staging', DROPI_MOCK: 'true' });

  const OrderM = seqz.models.Order;
  const [origUpd, origFind] = [OrderM.update, OrderM.findByPk];
  OrderM.update = async () => [0];
  OrderM.findByPk = async () => fakeOrder({ dropiOrderId: '9001', fulfillmentStatus: 'DISPATCHED', codStatus: 'collected' });
  let exDetails = null;
  seqz.query = async (sql, { replacements } = {}) => { if (/INSERT INTO order_exceptions/.test(sql)) { exDetails = JSON.parse(replacements.details); return [{ inserted: true }]; } return []; };
  const tgBefore = tg.length;
  const can = await auto.onCancelled(501);
  assert('cancelación tras el envío → excepción manual «cancelar en el panel de Dropi»', can.exception === 'cancelled_after_dispatch' && exDetails.action === 'cancelar en el panel de Dropi' && tg.slice(tgBefore).some((t) => /cancelar en el panel de Dropi/.test(t.body?.text || '')));
  seqz.query = async (sql) => (/FROM order_exceptions WHERE id/.test(sql) ? [{ id: 1, order_id: 501, type: 'dispatch_unknown', status: 'open' }] : []);
  const nn = await auto.resolveException(1, { resolution: 'not_created' }, 1).catch((x) => x);
  assert('not_created sin nota → 400 (reenvío manual auditado)', nn.output?.statusCode === 400);
  OrderM.update = origUpd; OrderM.findByPk = origFind; seqz.query = realQuery;
  delete seqz.models.AppSetting.findOne;

  out('\n▶ A5. Seguimiento visual: etapas derivadas del estado real (sin simular)');
  const { buildProgress } = require('../Services/orderProgress');
  const legacy = buildProgress({ state: 'pendiente_envio', stateOrder: 'en_transito', confirmedAt: '2026-10-01T10:00:00Z', fulfillmentStatus: 'MANUAL_LOGISTICS', trackingNumber: 'G1' });
  assert('pedido sin eventos en tránsito: etapas hechas pero SIN fecha inventada', legacy.currentStage === 'in_transit' && legacy.stages[4].done && legacy.stages[4].at === null && legacy.stages[1].at === null && legacy.stages[0].at === '2026-10-01T10:00:00.000Z' && !legacy.stages[5].done);
  const fresh = buildProgress({ state: 'pendiente_envio', stateOrder: 'comprado_pendiente_pago', confirmedAt: new Date(), fulfillmentStatus: 'AUTOMATION_OFF', carrierName: 'X' });
  assert('recién confirmado: solo "confirmado", sin transportadora', fresh.currentStage === 'confirmed' && fresh.stages.filter((x) => x.done).length === 1 && fresh.carrierName === null && fresh.status === 'in_progress');
  assert('carrito → status cart, ninguna etapa', buildProgress({ state: 'carrito', stateOrder: 'comprado_pendiente_pago' }).status === 'cart');
  const rej = buildProgress({ state: 'x', stateOrder: 'cancelado', dropiOrderId: 'D', dropiStatusHistory: [{ status: 'EN TRANSITO', group: 'transit', at: 't1' }, { status: 'RECHAZADO', group: 'rejected', at: 't2' }] });
  assert('rechazado → rama rejected con su fecha', rej.status === 'rejected' && rej.branch.at === 't2' && rej.branch.label);
  assert('cancelado sin rechazo → cancelled', buildProgress({ state: 'x', stateOrder: 'cancelado' }).status === 'cancelled');
  assert('por_devolver → returned', buildProgress({ state: 'x', stateOrder: 'por_devolver', dropiStatusHistory: [{ status: 'DEVOLUCION EN TRANSITO', group: 'returning', at: 't3' }] }).branch.at === 't3');
  out('\n▶ A7. Abastecimiento manual: aviso al cliente (borradores, nunca enviados)');
  const nCod = auto.customerNotice({ id: 82, paymentStatus: 'pending' }, ['Fuente de agua'], { alternatives: true });
  const kinds = nCod.options.map((o) => o.kind).join();
  assert('COD con candidatos no idénticos → retraso, sustitución (exige aceptación) y reembolso; sin «idéntica»', kinds === 'retraso,sustitucion,reembolso'
    && nCod.options.find((o) => o.kind === 'sustitucion').requiresCustomerAcceptance === true && /Solo la enviaremos si nos respondes que la aceptas/.test(nCod.options[1].text), kinds);
  assert('nada se envía solo (sent=false, autoSend=false)', nCod.sent === false && nCod.autoSend === false);
  assert('sin datos personales: nombre como marcador', nCod.options.every((o) => o.text.includes('{{nombre_cliente}}')) && /no se te cobrará/.test(nCod.options.at(-1).text));
  const nPaid = auto.customerNotice({ id: 7, paymentStatus: 'paid' }, ['X'], { identical: true });
  assert('pagado + alternativa idéntica → retraso, idéntica, reembolso con devolución', nPaid.options.map((o) => o.kind).join() === 'retraso,alternativa_identica,reembolso' && /devolvemos el importe/.test(nPaid.options.at(-1).text));
  assert('sourcing_required: bloqueante, admite retry y manual, NO accept', auto.EXCEPTION_TYPES.includes('sourcing_required') && auto.RESOLUTIONS.retry.includes('sourcing_required')
    && auto.RESOLUTIONS.manual.includes('sourcing_required') && !auto.RESOLUTIONS.accept.includes('sourcing_required'));
  assert('missing_dropi_id se conserva (compatibilidad con excepciones abiertas y supplier_id)', auto.EXCEPTION_TYPES.includes('missing_dropi_id'));
  assert('producto sin vínculo Dropi → sourcing_required (antes missing_dropi_id)', auto.buildDropiLines({ items: [{ id: 1, name: 'x', OrderProduct: { amount: 1 } }] }).problems[0].type === 'sourcing_required');

  assert('BLOCKED / DISPATCH_UNKNOWN / novedad → exception', ['BLOCKED', 'DISPATCH_UNKNOWN'].every((fs) => buildProgress({ state: 'x', stateOrder: 'en_preparacion', fulfillmentStatus: fs }).status === 'exception') && buildProgress({ state: 'x', stateOrder: 'en_transito', dropiStatusHistory: [{ status: 'NOVEDAD', group: 'issue', at: 't' }] }).status === 'exception');

  out('\n▶ A-alert. Aviso «pedido nuevo» al propietario (sin datos personales)');
  {
    const o = { id: 77, total: '41.5', paymentMethod: 'cod', fulfillmentStatus: 'AUTOMATION_OFF', isTest: false,
      customer: { name: 'Ana', lastName: 'Pérez', phone: '0991234567', streetAddress: 'Av. Amazonas N24-03', city: 'Quito <b>x</b>', user: { email: 'ana@cliente.ec' } },
      items: [{ OrderProduct: { amount: 2 } }, { OrderProduct: { amount: 1 } }] };
    const t = auto.ownerOrderAlertText(o);
    assert('incluye id, total, nº de ítems, ciudad, pago y enlace al panel', /#77/.test(t) && /\$41\.50/.test(t) && /3 ítem/.test(t) && /Quito/.test(t) && /cod/.test(t) && t.includes(auto.PANEL_URL));
    assert('sin nombre, teléfono, correo ni dirección', !/Ana|Pérez|0991234567|Amazonas|@cliente/.test(t));
    assert('HTML escapado (la ciudad no inyecta etiquetas)', t.includes('Quito &lt;b&gt;x&lt;/b&gt;') && !t.includes('<b>x</b>'));
    assert('isTestOrder: fuera de prod siempre prueba; en prod, is_test o email QA', auto.isTestOrder(o, false) && !auto.isTestOrder(o, true)
      && auto.isTestOrder({ ...o, isTest: true }, true) && auto.isTestOrder({ ...o, customer: { user: { email: 'qa+1@x.ec' } } }, true));
    assert('notifyOwnerNewOrder nunca lanza (pedido de prueba o null → false)', (await auto.notifyOwnerNewOrder(null)) === false && (await auto.notifyOwnerNewOrder(o, { prod: false })) === false);
  }

  out('\n▶ A-stock. Dropi sin dato de stock → null (antes -1)');
  {
    const { normalizeProduct } = require('../integrations/dropi/dropiAdapter');
    assert('sin campo de stock → null', normalizeProduct({ id: 1, name: 'x' }).stock === null);
    assert('stock no numérico → null', normalizeProduct({ id: 1, name: 'x', stock: 'n/a' }).stock === null);
    assert('stock 0 y 7 se conservan', normalizeProduct({ id: 1, name: 'x', stock: 0 }).stock === 0 && normalizeProduct({ id: 1, name: 'x', total_stock: '7' }).stock === 7);
  }
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
  const migTok = require('../db/migrations/20261020000003-order-tracking-token');
  await migTok.down(qi); await migTok.up(qi); await migTok.up(qi);
  const migAlert = require('../db/migrations/20261020000004-order-owner-alerted-at');
  await migAlert.down(qi);
  assert('down quita owner_alerted_at', !(await cols()).includes('owner_alerted_at'));
  await migAlert.up(qi); await migAlert.up(qi);
  assert('up (dos veces) crea owner_alerted_at', (await cols()).includes('owner_alerted_at'));
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
  env({ DROPI_ORDER_AUTO_ENABLED: 'true' }); // CEO-004: 'auto' exige su propio flag

  // Datos base
  const cat = await models.Category.create({ name: 'Test', image: 'x' });
  let uSeq = 0;
  async function customer(over = {}, email) {
    uSeq++;
    const user = await models.User.create({ email: email || `c${uSeq}@cliente.ec`, password: 'x', role: 'customer' });
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
  const noLink = await P({ dropiProductId: null, sourceProvider: null, dropiItems: null, name: 'Fuente de agua para gatos' });
  const c1b = await customer();
  const o1b = await order(c1b, [[noLink, 1]]);
  await svc.confirmCod(o1b.id, c1b.userId);
  const [ex1b] = await sel("SELECT details FROM order_exceptions WHERE order_id = :id AND type = 'sourcing_required' AND status = 'open'", { id: o1b.id });
  assert('interruptor apagado + producto sin proveedor → cola de abastecimiento manual, AUTOMATION_OFF, 0 llamadas',
    ex1b && (await reload(o1b.id)).fulfillmentStatus === 'AUTOMATION_OFF' && calls.length === 0 && ex1b.details.queue === 'abastecimiento_manual');
  assert('sin tabla supplier_candidates → candidatos [] y acción «Sin candidatos»', ex1b.details.products[0].candidates.length === 0 && /Sin candidatos/.test(ex1b.details.products[0].suggestedAction)
    && ex1b.details.customerNotice.sent === false);
  assert('aviso sin datos personales del cliente', !JSON.stringify(ex1b.details).match(/Ana|Pérez|0991234567|Amazonas|@cliente/));
  assert('el producto de abastecimiento no se envía a Dropi ni cambia', (await models.Product.findByPk(noLink.id)).dropiProductId === null);

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
  const ncNoNote = await auto.resolveException(ex4b.id, { resolution: 'not_created' }, 1).catch((e) => e);
  assert('"not_created" sin nota → 400 (el reenvío manual queda auditado)', ncNoNote.output?.statusCode === 400 && calls.length === n4b);
  const [ex4bRow] = await sel('SELECT details FROM order_exceptions WHERE id = :id', { id: ex4b.id });
  assert('dispatch_unknown pide buscar AYNIMAR-<id> en el panel antes de reenviar', String(ex4bRow.details.action).includes(`AYNIMAR-${o4b.id}`));
  const nc = await auto.resolveException(ex4b.id, { resolution: 'not_created', note: 'buscado AYNIMAR en el panel: no existe' }, 1);
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
  await blocked('sin ID Dropi', await customer(), [[await P({ dropiProductId: null }), 1]], 'sourcing_required');
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
  // dropi_not_found (p. ej. 82 / 81542) → abastecimiento manual con los candidatos de supplier_candidates
  await sequelize.query(`CREATE TABLE supplier_candidates (id SERIAL PRIMARY KEY, product_id INT NOT NULL, dropi_product_id VARCHAR(12) NOT NULL, dropi_variation_id VARCHAR(12),
    name TEXT, cost DECIMAL(10,2), stock INT, classification VARCHAR(10) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'propuesto')`);
  const gone = await P({ dropiProductId: '81542', name: 'Fuente de agua para gatos comedero 2 en1' });
  await sequelize.query("INSERT INTO catalog_issues (product_id, type) VALUES (:id, 'dropi_not_found')", { replacements: { id: gone.id } });
  await sequelize.query(`INSERT INTO supplier_candidates (product_id, dropi_product_id, name, cost, stock, classification, status) VALUES
    (:id, '176296', 'FUENTE DE AGUA Y COMEDOR MASCOTA 2 EN 1', 18.5, 98, 'SIMILAR', 'propuesto'),
    (:id, '123170', 'Fuente De Agua Y Comida Mascotas 2 En 1', 16, 11, 'SIMILAR', 'propuesto'),
    (:id, '185342', 'Dispensador de agua para gatos', 11, 556, 'DISTINTO', 'descartado')`, { replacements: { id: gone.id } });
  const oGone = await blocked('Dropi id ya no existe (catalog_issues dropi_not_found)', await customer(), [[gone, 1]], 'sourcing_required');
  const [exG] = await sel("SELECT id, details FROM order_exceptions WHERE order_id = :id AND type = 'sourcing_required'", { id: oGone.id });
  const pG = exG.details.products[0];
  assert('candidatos vivos (sin descartados), ordenados y con acción sugerida', pG.candidates.map((c) => c.dropiProductId).join() === '123170,176296'
    && /ninguno confirmado como idéntico/.test(pG.suggestedAction) && pG.identical === false, JSON.stringify(pG));
  assert('aviso al cliente incluye sustitución con aceptación obligatoria', exG.details.customerNotice.options.some((o) => o.kind === 'sustitucion' && o.requiresCustomerAcceptance));
  await sequelize.query("UPDATE supplier_candidates SET classification = 'EXACTO', status = 'preparado_preferente' WHERE dropi_product_id = '123170'");
  await models.Order.update({ fulfillmentStatus: 'PENDING_DISPATCH' }, { where: { id: oGone.id } }); // re-evaluación (como hace el worker/retry)
  await svc._dispatchOrder(await svc.findOne(oGone.id));
  const [exG2] = await sel("SELECT details FROM order_exceptions WHERE order_id = :id AND type = 'sourcing_required' AND status = 'open'", { id: oGone.id });
  assert('con un preferente EXACTO: acción = vincular en Salud del catálogo y reintentar; aviso «idéntica»; sigue sin enviarse',
    /MISMO artículo/.test(exG2.details.products[0].suggestedAction) && exG2.details.customerNotice.options.some((o) => o.kind === 'alternativa_identica')
    && (await reload(oGone.id)).fulfillmentStatus === 'BLOCKED' && (await models.Product.findByPk(gone.id)).dropiProductId === '81542');
  const accG = await auto.resolveException(exG.id, { resolution: 'accept', note: 'x' }, 1).catch((e) => e);
  assert('sourcing_required no se puede «aceptar» → 400', accG.output?.statusCode === 400);
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

  out('\n▶ B16. Seguimiento: /orders/mine/progress (JWT) y /orders/track/:token (público, sin PII)');
  {
    const express = require('express');
    require('../utils/auth');
    const jwt = require('jsonwebtoken');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/orders', require('../routes/orderRouter'));
    app.use((err, req, res, next) => (err.isBoom ? res.status(err.output.statusCode).json(err.output.payload) : res.status(500).json({ message: err.message }))); // eslint-disable-line no-unused-vars
    const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1/orders`;
    const get = async (url, uid) => {
      const res = await fetch(url, { headers: uid ? { Authorization: `Bearer ${jwt.sign({ sub: uid, role: 'customer' }, process.env.JWT_SECRET)}` } : {} });
      return { status: res.status, json: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
    };
    try {
      // Pedido con guía real
      const cG = await customer();
      const oG = await order(cG, [[good, 1]]);
      const confG = await svc.confirmCod(oG.id, cG.userId);
      statusFeed[(await reload(oG.id)).dropiOrderId] = { status: 'GUIA_GENERADA', trackingNumber: 'G-77', carrierName: 'SERVIENTREGA' };
      await svc.syncDropiDeliveryStatus(oG.id);
      statusFeed[(await reload(oG.id)).dropiOrderId] = { status: 'EN TRÁNSITO' };
      await svc.syncDropiDeliveryStatus(oG.id);

      assert('sin token → 401', (await get(`${base}/mine/progress`)).status === 401);
      const mine = await get(`${base}/mine/progress`, cG.userId);
      const item = mine.json?.items?.[0];
      assert('mis pedidos → 200, solo los del usuario, no-store', mine.status === 200 && mine.json.items.length === 1 && item.orderId === oG.id && mine.cache === 'no-store');
      assert('trackingToken opaco de 24 caracteres y estable', /^[A-Za-z0-9_-]{24}$/.test(item.trackingToken) && (await get(`${base}/mine/progress`, cG.userId)).json.items[0].trackingToken === item.trackingToken);
      assert('confirmCod devuelve el mismo trackingToken (idempotente)', confG.trackingToken === item.trackingToken);
      const cK2 = await customer();
      const oK2 = await order(cK2, [[good, 1]]);
      const chk = await svc.checkout(oK2.id, cK2.userId, 0);
      assert('checkout devuelve trackingToken opaco y estable', /^[A-Za-z0-9_-]{24}$/.test(chk.trackingToken) && (await reload(oK2.id)).trackingToken === chk.trackingToken && chk.orderId === oK2.id);
      const chkOther = await svc.checkout(oK2.id, cG.userId, 0).catch((e) => e);
      assert('checkout de un tercero → 403 (sin token)', chkOther.output?.statusCode === 403);
      const st = item.progress.stages;
      assert('etapas reales con fechas: confirmado, validado, enviado, guía, en camino', item.progress.currentStage === 'in_transit' && st.slice(0, 5).every((x) => x.done && x.at) && !st[5].done && st[5].at === null);
      assert('guía y transportadora reales', item.progress.trackingNumber === 'G-77' && item.progress.carrierName === 'SERVIENTREGA');

      const pub = await get(`${base}/track/${item.trackingToken}`);
      assert('público por token → 200 con el contrato previo + progress', pub.status === 200 && pub.json.id === oG.id && pub.json.stateOrder === 'en_transito' && pub.json.trackingNumber === 'G-77' && 'createdAt' in pub.json && pub.json.customerName === null && pub.json.progress.currentStage === 'in_transit');
      assert('público sin datos personales', !JSON.stringify(pub.json).match(/Ana|Pérez|0991234567|Amazonas|@cliente|total/i));
      assert('id secuencial → 404 (no enumerable)', (await get(`${base}/track/${oG.id}`)).status === 404);
      assert('token inexistente o mal formado → 404', (await get(`${base}/track/AAAAAAAAAAAAAAAAAAAAAAAA`)).status === 404 && (await get(`${base}/track/x'--`)).status === 404);

      const { buildProgress } = require('../Services/orderProgress');
      const pr = async (id) => buildProgress(await reload(id));
      assert('entregado → delivered (o2)', (await pr(o2.id)).status === 'delivered');
      assert('rechazado (o3) → rejected; devuelto (oRv) → returned', (await pr(o3.id)).status === 'rejected' && (await pr(oRv.id)).status === 'returned');
      assert('cancelado tras envío (oA) → cancelled; interruptor OFF (o1) → solo confirmado', (await pr(oA.id)).status === 'cancelled' && (await pr(o1.id)).currentStage === 'confirmed');
      assert('bloqueado (oP) y novedad (o4) → exception', (await pr(oP.id)).status === 'exception' && (await pr(o4.id)).status === 'exception');
    } finally {
      server.close();
    }
  }

  out('\n▶ B17. Aviso «pedido nuevo» al propietario: uno por pedido real, en todos los caminos');
  {
    const wait = () => new Promise((r) => setTimeout(r, 300));
    const prevMode = process.env.DROPI_ORDER_AUTOMATION;
    const alerts = (id) => tg.filter((m) => m.method === 'sendMessage' && String(m.body?.text).startsWith(`🛒 <b>Pedido nuevo #${id}</b>`));
    env({ DROPI_ORDER_AUTOMATION: undefined });
    const cS = await customer();
    const oS = await order(cS, [[good, 2]]);
    await svc.confirmCod(oS.id, cS.userId); await wait();
    assert('staging: pedido de prueba → sin aviso', alerts(oS.id).length === 0 && (await reload(oS.id)).ownerAlertedAt === null);
    env({ RAILWAY_ENVIRONMENT_NAME: 'production' });
    try {
      const cOff = await customer();
      const oOff = await order(cOff, [[good, 2]]);
      await svc.confirmCod(oOff.id, cOff.userId); await wait();
      const a = alerts(oOff.id);
      assert('prod + AUTOMATION_OFF → 1 aviso con estado y sin PII', a.length === 1 && /AUTOMATION_OFF/.test(a[0].body.text) && /2 ítem/.test(a[0].body.text) && !/Ana|Pérez|0991234567|Amazonas|@cliente/.test(a[0].body.text));
      assert('owner_alerted_at fijado', (await reload(oOff.id)).ownerAlertedAt instanceof Date);
      const full = await svc.findOne(oOff.id);
      assert('segunda llamada (y concurrentes) → no se repite', (await Promise.all([auto.notifyOwnerNewOrder(full), auto.notifyOwnerNewOrder(full)])).every((x) => x === false) && alerts(oOff.id).length === 1);
      const cSrc = await customer();
      const oSrc = await order(cSrc, [[noLink, 1]]);
      await svc.confirmCod(oSrc.id, cSrc.userId); await wait();
      assert('prod + sourcing_required → aviso de abastecimiento + aviso de pedido', alerts(oSrc.id).length === 1 && (await exTypes(oSrc.id)).includes('sourcing_required'));
      env({ DROPI_ORDER_AUTOMATION: 'auto' });
      const cB = await customer();
      const oB = await order(cB, [[good, 1]]);
      await svc.confirmCod(oB.id, cB.userId); await wait();
      assert('prod + automatización activa (aquí BLOCKED por mock) → 1 aviso', alerts(oB.id).length === 1);
      const cQ = await customer({}, 'qa+alert@cliente.ec');
      const oQ = await order(cQ, [[good, 1]]);
      await svc.confirmCod(oQ.id, cQ.userId); await wait();
      assert('prod + email de QA → sin aviso', alerts(oQ.id).length === 0);
      // Telegram caído: el pedido se confirma igual.
      const prevFetch = global.fetch;
      global.fetch = async (url, opts) => (new URL(String(url)).hostname === 'api.telegram.org' ? Promise.reject(new Error('telegram caído')) : prevFetch(url, opts));
      env({ DROPI_ORDER_AUTOMATION: undefined });
      const cF = await customer();
      const oF = await order(cF, [[good, 1]]);
      let threw = null;
      try { await svc.confirmCod(oF.id, cF.userId); await wait(); } catch (e) { threw = e; }
      global.fetch = prevFetch;
      const rF = await reload(oF.id);
      assert('Telegram caído → el pedido se confirma igual', !threw && rF.state === 'pendiente_envio' && rF.fulfillmentStatus === 'AUTOMATION_OFF');
    } finally {
      env({ RAILWAY_ENVIRONMENT_NAME: 'staging', DROPI_ORDER_AUTOMATION: prevMode });
    }
  }

  out('\n▶ B18. Stock negativo (-1 heredado de Dropi) = sin dato: no bloquea checkout ni confirmCod');
  {
    const neg = await P({ stock: -1, name: 'Producto 23 (stock -1)' });
    const cN = await customer();
    const oN = await order(cN, [[neg, 2]]);
    const chkN = await svc.checkout(oN.id, cN.userId, 0).catch((e) => e);
    assert('checkout con stock -1 → OK (antes 409)', !(chkN instanceof Error), chkN?.message);
    const cN2 = await customer();
    const oN2 = await order(cN2, [[neg, 2]]);
    const confN = await svc.confirmCod(oN2.id, cN2.userId).catch((e) => e);
    assert('confirmCod con stock -1 → OK y el stock no se descuenta', !(confN instanceof Error) && (await models.Product.findByPk(neg.id)).stock === -1, confN?.message);
    const few = await P({ stock: 1 });
    const cN3 = await customer();
    const oN3 = await order(cN3, [[few, 2]]);
    const confN3 = await svc.confirmCod(oN3.id, cN3.userId).catch((e) => e);
    assert('stock 1 con pedido de 2 → sigue 409', confN3?.output?.statusCode === 409, confN3?.message);
  }

  out('\n▶ B19. add-item / add-item-guest: el mismo producto suma cantidad (no duplica la línea)');
  {
    // sync() crea UNIQUE(order_id, product_id) por el belongsToMany; la BD real (migraciones)
    // no lo tiene (por eso se duplicaban líneas). Se quita para reproducir la BD real.
    await sequelize.query('ALTER TABLE orders_products DROP CONSTRAINT IF EXISTS orders_products_order_id_product_id_key');
    const cC = await customer();
    const cart = await order(cC, []);
    const me = { sub: cC.userId, role: 'customer' };
    const l1 = await svc.addItem({ orderId: cart.id, productId: good.id, amount: 1 }, me);
    const l2 = await svc.addItem({ orderId: cart.id, productId: good.id, amount: 2 }, me);
    const rows = await models.OrderProduct.findAll({ where: { orderId: cart.id } });
    assert('add-item ×2 → 1 línea con amount 3 (misma línea devuelta)', rows.length === 1 && rows[0].amount === 3 && l1.id === l2.id, `${rows.length} ${rows.map((x) => x.amount)}`);
    await svc.addItem({ orderId: cart.id, productId: good.id, amount: 1, selectedDropiId: '555' }, me);
    await svc.addItem({ orderId: cart.id, productId: good.id, amount: 1, selectedDropiId: '555' }, me);
    const rows2 = await models.OrderProduct.findAll({ where: { orderId: cart.id }, order: [['id', 'ASC']] });
    assert('otra variante → línea aparte, y se suma consigo misma', rows2.length === 2 && rows2[1].amount === 2 && rows2[1].selectedDropiId === '555');
    const guest = await models.Order.create({});
    const g1 = await svc.addItemToGuestOrder({ orderId: guest.id, productId: good.id, amount: 1 });
    const g2 = await svc.addItemToGuestOrder({ orderId: guest.id, productId: good.id, amount: 1, selectedDropiId: '' });
    const gRows = await models.OrderProduct.findAll({ where: { orderId: guest.id } });
    assert('add-item-guest ×2 (null y "") → 1 línea con amount 2', gRows.length === 1 && gRows[0].amount === 2 && g1.id === g2.id);

    out('\n▶ B20. IDOR del carrito (BD real): add-item / items / associate-order');
    const cO = await customer();
    const nf = async (p) => (await p.catch((e) => e))?.output?.statusCode;
    const before = await models.OrderProduct.count({ where: { orderId: cart.id } });
    assert('add-item al carrito de otro cliente → 404 sin crear línea', await nf(svc.addItem({ orderId: cart.id, productId: good.id, amount: 1 }, { sub: cO.userId, role: 'customer' })) === 404
      && await models.OrderProduct.count({ where: { orderId: cart.id } }) === before);
    assert('add-item a orden inexistente → 404', await nf(svc.addItem({ orderId: 999999, productId: good.id, amount: 1 }, me)) === 404);
    const done = await order(cO, [[good, 1]], { state: 'pendiente_envio' });
    assert('add-item a pedido ya confirmado (propio) → 404', await nf(svc.addItem({ orderId: done.id, productId: good.id, amount: 1 }, { sub: cO.userId, role: 'customer' })) === 404);
    assert('admin → puede añadir', !((await svc.addItem({ orderId: cart.id, productId: (await P({})).id, amount: 1 }, { sub: 0, role: 'admin' }).catch((e) => e)) instanceof Error));
    const g3 = await svc.addItem({ orderId: guest.id, productId: good.id, amount: 1 }, { sub: cO.userId, role: 'customer' }).catch((e) => e);
    assert('add-item con JWT a un carrito de invitado → sigue funcionando (compatibilidad)', !(g3 instanceof Error) && g3.amount === 3);
    const item = rows[0];
    assert('PATCH item ajeno → 404 (antes 403)', await nf(svc.updateCartItem(item.id, { amount: 9 }, { sub: cO.userId, role: 'customer' })) === 404 && (await models.OrderProduct.findByPk(item.id)).amount === 3);
    assert('DELETE item ajeno sin JWT → 404', await nf(svc.deleteCartItem(item.id, null)) === 404 && !!(await models.OrderProduct.findByPk(item.id)));
    assert('GET item ajeno → 404; dueño → 200', await nf(svc.findCartItem(item.id, { sub: cO.userId, role: 'customer' })) === 404 && (await svc.findCartItem(item.id, me)).id === item.id);
    assert('PATCH item propio → OK', (await svc.updateCartItem(item.id, { amount: 4 }, me)).amount === 4);
    assert('item de invitado sin JWT → editable (mecanismo de invitado)', (await svc.updateCartItem(gRows[0].id, { amount: 5 }, null)).amount === 5);
    assert('associate-order de un carrito de OTRO cliente → 404 (antes devolvía su orden)', await nf(svc.associateOrderToCustomer(cart.id, cO.userId)) === 404 && (await reload(cart.id)).customerId === cC.id);
    assert('associate-order de su propio carrito → idempotente', (await svc.associateOrderToCustomer(cart.id, cC.userId)).id === cart.id);
    const guest2 = await models.Order.create({});
    assert('associate-order de un carrito de invitado → se asocia', (await svc.associateOrderToCustomer(guest2.id, cO.userId)).customerId === cO.id);
  }

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
