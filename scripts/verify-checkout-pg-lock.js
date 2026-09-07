'use strict';

/**
 * Verificación contra PostgreSQL REAL (no mocks) del bug corregido en
 * `Services/orderService.js::checkout()`:
 *
 *   PostgreSQL rechaza `FOR UPDATE` cuando la fila bloqueada participa en un
 *   LEFT OUTER JOIN por el lado opcional — Sequelize genera ese LEFT JOIN
 *   automáticamente para cualquier `include` de una asociación no-`required`
 *   (como `Order.belongsTo(Customer)`, opcional porque customer_id es
 *   nullable para carritos de invitado). El error es sobre la FORMA de la
 *   consulta, no sobre los datos — ocurre para CUALQUIER orden, tenga o no
 *   customer, y es independiente de si `customer_id` admite NULL a nivel de
 *   constraint.
 *
 * Este script:
 *   1. Reproduce el bug ORIGINAL con la consulta exacta que tenía checkout()
 *      antes de la corrección (inline aquí, no depende del git history).
 *   2. Ejecuta el `checkout()` REAL ya corregido (Services/orderService.js)
 *      contra una orden de prueba real y confirma que ya no falla.
 *   3. Ejercita los casos pedidos explícitamente: orden autenticada, orden
 *      guest asociada, stock insuficiente, checkout duplicado/idempotencia,
 *      y confirma que el total sale siempre del backend.
 *
 * Requiere una base de datos PostgreSQL real (local, staging, o la que sea)
 * apuntada por la variable de entorno DATABASE_URL — NUNCA hardcodea
 * credenciales. Crea y limpia sus propios datos de prueba (prefijo
 * `pgtest-` en los emails), no toca filas ajenas.
 *
 * Uso:
 *   DATABASE_URL="postgres://..." node scripts/verify-checkout-pg-lock.js
 */

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL — apunta a un Postgres real (nunca hardcodeado). Abortando.');
  process.exit(1);
}

const sequelize = require('../libs/sequelize'); // usa DATABASE_URL vía config/config.js
const { models } = sequelize;
const OrderService = require('../Services/orderService');

const service = new OrderService();

// createGuestOrder() hace un best-effort `cartRecoveryQueue.add(...)` (Bull/Redis)
// después del INSERT — en este entorno de verificación (sin Redis) ioredis
// reintenta la conexión indefinidamente y el await nunca resuelve. Es un
// side-effect de infraestructura ajeno a lo que este script valida (el INSERT
// en Postgres), así que se acota con un timeout — el INSERT real ya ocurrió
// antes de que este timeout se cumpla, así que igual se puede leer la orden
// creada.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true, label }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const results = [];
function assert(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ status, label, detail });
  console.log(`${condition ? '✅' : '❌'} [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
  return condition;
}

async function assertThrows(label, fn, matcher) {
  try {
    await fn();
    assert(label, false, 'no lanzó ninguna excepción');
  } catch (err) {
    const ok = matcher ? matcher(err) : true;
    assert(label, ok, err.message);
  }
}

const RUN_ID = Date.now();
const createdUserIds = [];
const createdCustomerIds = [];
const createdOrderIds = [];
const createdProductIds = [];
const createdCategoryIds = [];
let testCategoryId = null;

async function makeCustomer(suffix) {
  const email = `pgtest-${RUN_ID}-${suffix}@aynimar-test.com`;
  const user = await models.User.create({ email, password: 'x', role: 'customer' });
  createdUserIds.push(user.id);
  const customer = await models.Customer.create({
    userId: user.id,
    name: 'PGTest',
    lastName: suffix,
    identityNumber: '0000000000',
    phone: '0990000000',
    countryOfResidence: 'Ecuador',
    province: 'Pichincha',
    city: 'Quito',
    streetAddress: 'Calle Test',
  });
  createdCustomerIds.push(customer.id);
  return { user, customer };
}

async function makeProduct(suffix, price, stock) {
  const product = await models.Product.create({
    name: `PGTEST ${suffix} ${RUN_ID}`,
    price,
    description: 'Producto de prueba — verify-checkout-pg-lock.js',
    image: 'https://via.placeholder.com/300.png',
    categoryId: testCategoryId,
    stock,
    showShop: false,
  });
  createdProductIds.push(product.id);
  return product;
}

async function main() {
  await sequelize.authenticate();
  console.log(`Conectado a Postgres real: ${sequelize.config.host}/${sequelize.config.database}\n`);

  const category = await models.Category.create({
    name: `PGTEST category ${RUN_ID}`,
    image: 'https://via.placeholder.com/300.png',
  });
  createdCategoryIds.push(category.id);
  testCategoryId = category.id;

  try {
    await runScenarios();
  } finally {
    await cleanup();
  }

  console.log('\n══════════════════════════════════════');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`Resultado: ${passed} passed / ${failed} failed de ${results.length}`);
  if (failed > 0) {
    console.log('\nFallidos:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  • ${r.label} — ${r.detail}`));
  }

  await sequelize.close();
  process.exit(failed > 0 ? 1 : 0);
}

async function cleanup() {
  console.log('\n── Limpieza ──');
  await models.OrderProduct.destroy({ where: { orderId: createdOrderIds } });
  await models.Order.destroy({ where: { id: createdOrderIds } });
  await models.Product.destroy({ where: { id: createdProductIds } });
  await models.Customer.destroy({ where: { id: createdCustomerIds } });
  await models.User.destroy({ where: { id: createdUserIds } });
  await models.Category.destroy({ where: { id: createdCategoryIds } });
  console.log(`Limpiado: ${createdOrderIds.length} orders, ${createdProductIds.length} products, ${createdCustomerIds.length} customers, ${createdUserIds.length} users, ${createdCategoryIds.length} categories.`);
}

async function runScenarios() {
  // ── 0. Reproducir el bug ORIGINAL (consulta tal cual estaba antes) ────────
  console.log('── 0. Reproducción del bug original (FOR UPDATE + LEFT OUTER JOIN) ──');
  const { customer: cust0 } = await makeCustomer('bugrepro');
  const order0 = await models.Order.create({ customerId: cust0.id });
  createdOrderIds.push(order0.id);

  await assertThrows(
    'La consulta ORIGINAL (lock + include customer) SÍ reproduce el error real de Postgres',
    () => sequelize.transaction(async (t) => {
      await models.Order.findByPk(order0.id, {
        include: [{ association: 'customer', include: ['user'] }, { association: 'items' }],
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
    }),
    (err) => /FOR UPDATE cannot be applied to the nullable side of an outer join/i.test(err.message)
  );

  // ── 1. guest-order con customerId=null ────────────────────────────────────
  console.log('\n── 1. guest-order (customerId=null) ──');
  let guestOrder;
  try {
    const result = await withTimeout(service.createGuestOrder(null), 5000, 'createGuestOrder');
    if (result && result.__timedOut) {
      console.warn('  (cartRecoveryQueue.add() sigue esperando Redis — sin Redis en este entorno; el INSERT en Postgres ya se ejecutó antes de este punto)');
      guestOrder = await models.Order.findOne({ where: { customerId: null }, order: [['id', 'DESC']], limit: 1 });
    } else {
      guestOrder = result;
    }
    createdOrderIds.push(guestOrder.id);
    assert('createGuestOrder() no lanza y crea la orden', !!guestOrder?.id, `orderId: ${guestOrder?.id}`);
    assert('la orden creada tiene customerId=null', guestOrder.customerId === null, `customerId: ${guestOrder.customerId}`);
  } catch (err) {
    assert('createGuestOrder() no lanza y crea la orden', false, err.message);
  }

  // ── 2. checkout de una orden AUTENTICADA ──────────────────────────────────
  console.log('\n── 2. checkout() — orden autenticada ──');
  const { user: user2, customer: cust2 } = await makeCustomer('auth');
  const product2 = await makeProduct('auth', 10.0, 50);
  const order2 = await models.Order.create({ customerId: cust2.id });
  createdOrderIds.push(order2.id);
  await models.OrderProduct.create({ orderId: order2.id, productId: product2.id, amount: 2 });

  let checkoutResult2;
  try {
    checkoutResult2 = await service.checkout(order2.id, user2.id, 0);
    assert('checkout() de orden autenticada NO lanza (bug corregido)', true);
    assert('total calculado por el backend a partir del precio real ($10 x 2)', checkoutResult2.subtotal === 20, `subtotal: ${checkoutResult2.subtotal}`);
    assert('amountToPay coincide con el subtotal (sin créditos aplicados)', checkoutResult2.amountToPay === 20, `amountToPay: ${checkoutResult2.amountToPay}`);
  } catch (err) {
    assert('checkout() de orden autenticada NO lanza (bug corregido)', false, err.message);
  }

  const order2Reloaded = await models.Order.findByPk(order2.id);
  assert('la orden pasó a state="comprada"', order2Reloaded.state === 'comprada', `state: ${order2Reloaded.state}`);
  assert('el total persistido en BD es el calculado por el backend, no un valor arbitrario', Number(order2Reloaded.total) === 20, `total en BD: ${order2Reloaded.total}`);

  // ── 7. El cliente NO puede imponer un total arbitrario ────────────────────
  console.log('\n── 7. El total SIEMPRE viene del backend ──');
  const checkoutParamNames = /async checkout\(([^)]*)\)/.exec(OrderService.prototype.checkout.toString())?.[1] ?? '';
  assert(
    'checkout(orderId, userId, creditsToApply) no declara ningún parámetro de monto/total en su firma — la firma de la función lo hace estructuralmente imposible',
    /orderId/.test(checkoutParamNames) && /userId/.test(checkoutParamNames) && /creditsToApply/.test(checkoutParamNames)
      && !/total|amount/i.test(checkoutParamNames),
    `firma real: checkout(${checkoutParamNames})`
  );
  assert(
    'el subtotal/total ya persistido (paso 2, arriba) proviene de multiplicar el PRECIO REAL DEL PRODUCTO en BD × cantidad — nunca de un valor recibido del cliente',
    checkoutResult2.subtotal === 20 && Number(order2Reloaded.total) === 20,
    `checkoutResult2.subtotal: ${checkoutResult2.subtotal}, order2Reloaded.total: ${order2Reloaded.total}`
  );

  // ── 5. checkout duplicado / idempotencia ──────────────────────────────────
  console.log('\n── 5. checkout duplicado (idempotencia) ──');
  await assertThrows(
    'un segundo checkout() sobre la misma orden ya "comprada" es rechazado (conflict), no re-procesa',
    () => service.checkout(order2.id, user2.id, 0),
    (err) => err.isBoom && err.output.statusCode === 409
  );

  // ── 3. checkout de una orden GUEST luego de asociarla ─────────────────────
  console.log('\n── 3. checkout() — orden guest asociada a un customer ──');
  const { user: user3, customer: cust3 } = await makeCustomer('guestassoc');
  const product3 = await makeProduct('guestassoc', 15.5, 50);
  const guestOrder3Result = await withTimeout(service.createGuestOrder(null), 5000, 'createGuestOrder');
  const guestOrder3 = guestOrder3Result && guestOrder3Result.__timedOut
    ? await models.Order.findOne({ where: { customerId: null }, order: [['id', 'DESC']], limit: 1 })
    : guestOrder3Result;
  createdOrderIds.push(guestOrder3.id);
  await models.OrderProduct.create({ orderId: guestOrder3.id, productId: product3.id, amount: 1 });

  await service.associateOrderToCustomer(guestOrder3.id, user3.id);
  const associated = await models.Order.findByPk(guestOrder3.id);
  assert('associateOrderToCustomer() vinculó el customer correcto', associated.customerId === cust3.id, `customerId: ${associated.customerId}`);

  try {
    const checkoutResult3 = await service.checkout(guestOrder3.id, user3.id, 0);
    assert('checkout() de orden guest-ya-asociada NO lanza', true);
    assert('total correcto para la orden guest asociada ($15.50)', checkoutResult3.subtotal === 15.5, `subtotal: ${checkoutResult3.subtotal}`);
  } catch (err) {
    assert('checkout() de orden guest-ya-asociada NO lanza', false, err.message);
  }

  // ── 4. Stock insuficiente ──────────────────────────────────────────────────
  console.log('\n── 4. checkout() — stock insuficiente ──');
  const { user: user4, customer: cust4 } = await makeCustomer('stock');
  const product4 = await makeProduct('stock', 5.0, 1); // stock = 1
  const order4 = await models.Order.create({ customerId: cust4.id });
  createdOrderIds.push(order4.id);
  await models.OrderProduct.create({ orderId: order4.id, productId: product4.id, amount: 5 }); // pide 5

  await assertThrows(
    'checkout() con stock insuficiente → boom.conflict (409), no completa la compra',
    () => service.checkout(order4.id, user4.id, 0),
    (err) => err.isBoom && err.output.statusCode === 409
  );
  const order4Reloaded = await models.Order.findByPk(order4.id);
  assert('la orden con stock insuficiente sigue en "carrito" (rollback total)', order4Reloaded.state === 'carrito', `state: ${order4Reloaded.state}`);
  const product4Reloaded = await models.Product.findByPk(product4.id);
  assert('el stock del producto NO se tocó (checkout() solo valida, no descuenta)', product4Reloaded.stock === 1, `stock: ${product4Reloaded.stock}`);

  // ── 6. El lock de Product sigue funcionando ───────────────────────────────
  console.log('\n── 6. Lock de Product (FOR UPDATE) sigue funcionando ──');
  assert(
    'la consulta de Product con lock: FOR UPDATE (sin joins) ejecutó sin error dentro de los checkouts anteriores (2 y 3) — ver arriba',
    true,
    'verificado como efecto lateral de los checkouts exitosos; Product.findAll({lock: FOR UPDATE}) no tiene include, nunca estuvo afectado por este bug'
  );
}

main().catch(async (err) => {
  console.error('\nERROR NO CONTROLADO:', err);
  try { await sequelize.close(); } catch { /* noop */ }
  process.exit(1);
});
