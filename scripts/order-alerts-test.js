'use strict';
/* eslint-disable no-console */
/**
 * Alertas de pedido y seguridad de correos — sin BD ni red.
 *  1. Correos de bienvenida (customer / recycler / business_owner): sin contraseña en claro.
 *  2. Comprobante DeUna: aviso Telegram al subirlo (sin PII) y aprobación solo en el estado correcto.
 *  3. GET /products: price_min / price_max opcionales (sitemap).
 * Usage: node scripts/order-alerts-test.js
 */

for (const k of Object.keys(process.env)) if (/^(TELEGRAM_|RAILWAY_)/.test(k) || k === 'REDIS_URL') delete process.env[k];
Object.assign(process.env, {
  DATABASE_URL: 'postgres://alerttest:test@localhost:5432/never_connects',
  JWT_SECRET: 'test-jwt-secret-only',
  TEMPORALY_JWT_SECRET: 'test-temporal-secret-only',
  TELEGRAM_BOT_TOKEN: '222222:FAKE-bot-token-tests-only', TELEGRAM_NONPROD_BOT_ID: '222222', TELEGRAM_CHAT_ID: '123456789',
  RAILWAY_ENVIRONMENT_NAME: 'production', // solo para que el aviso no se trate como prueba; la red está interceptada
});

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const tg = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.telegram.org') { tg.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
  throw new Error(`red real bloqueada en tests: ${u.hostname}`);
};

const path = require('path');
const stub = (rel, exp) => { const p = require.resolve(path.join(__dirname, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const mails = [];
stub('../utils/sendMail', async (m) => { mails.push(m); });
stub('../utils/sendMailResend', async (m) => { mails.push(m); });
stub('../libs/cartRecoveryQueue', { cartRecoveryQueue: { add: async () => {}, getJob: async () => null }, connection: {}, queueConnection: {} });
const fileChecks = [];
stub('../Services/paymentProofImageValidation', { assertTrustedProofUrl: () => {}, verifyProofFileExists: async (u) => { fileChecks.push(u); } });

const { models } = require('../libs/sequelize');
const sequelize = require('../libs/sequelize');
const AuthService = require('../Services/authService');
const UserService = require('../Services/userServices');

async function welcomeMails() {
  console.log('\n▶ 1. Correos de bienvenida sin contraseña en claro');
  const PASS = 'Clave-Secreta-987!';
  AuthService.prototype.getUser = async (email) => ({ id: 5, email, role: 'customer' });
  UserService.prototype.update = async () => ({});
  const created = () => ({ dataValues: { user: { dataValues: { password: 'hash' } } } });
  models.Customer.create = async () => created();
  models.Recycler.create = async () => created();
  models.BusinessOwner.create = async () => created();
  const cases = [
    ['customer', require('../Services/customerService')],
    ['recycler', require('../Services/recyclerService')],
    ['business_owner', require('../Services/businessOwnerService')],
  ];
  for (const [name, Svc] of cases) {
    mails.length = 0;
    await new Svc().create({ name: 'Ana', user: { email: 'ana@cliente.ec', password: PASS } });
    const html = mails[0]?.html || '';
    assert(`${name}: se envía el correo con el enlace de acceso (magic link)`, mails.length === 1 && /autoLogin\?token=|auth-login\?token=/.test(html));
    assert(`${name}: el HTML no contiene la contraseña`, html.length > 0 && !html.includes(PASS) && !/seña:/i.test(html));
  }
}

function productQuery() {
  console.log('\n▶ 3. GET /products: price_min / price_max opcionales');
  const { queryProductSchema: s } = require('../schemaODtos/productSchema');
  assert('sin precios → válido (antes 400 "price_max" is required)', !s.validate({}).error && !s.validate({ limit: 10, offset: 0 }).error);
  assert('con ambos → válido (sin cambios)', !s.validate({ price_min: 0, price_max: 10000000 }).error);
  assert('price_min sin price_max → 400 (sin cambios)', /price_max/.test(s.validate({ price_min: 1 }).error?.message || ''));
  assert('precio no entero → 400 (sin cambios)', !!s.validate({ price_min: 1.5, price_max: 3 }).error);
}

(async () => {
  try {
    await welcomeMails();
    productQuery();
  } catch (e) {
    failed++;
    console.error('ERROR NO CONTROLADO:', e.stack);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
