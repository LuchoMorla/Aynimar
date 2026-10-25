'use strict';
/* eslint-disable no-console */

/**
 * Smart Shipping — Fase B (ops-ceo-cto/informes/smart-shipping/01-fase-a.md §4).
 * El servidor es la única fuente de verdad: el cliente solo envía quoteId + optionId.
 *
 * Flag: app_settings.smart_shipping (JSON). APAGADO por defecto y fail-closed
 * (fila ausente, JSON inválido o error de BD → apagado). Sin variables de Railway.
 *   { "enabled": false, "adapter": "dropiTable", "ttlMinutes": 15,
 *     "policy": { "mode": "excess", "multiplier": 1 } }
 * Política (CEO-021, PROPUESTA pendiente de Luis → configurable):
 *   excess — recargo = máx(0, coste − flete incluido en el PVP) × multiplier, al céntimo hacia arriba.
 *   absorb — recargo 0 siempre (Aynimar absorbe la diferencia).
 * Nunca hay recargo negativo ni se cobra el flete completo aparte.
 */

const crypto = require('crypto');
const boom = require('@hapi/boom');
const { Op } = require('sequelize');
const { models } = require('../libs/sequelize');
const adapters = require('../integrations/shipping/adapters');
const automation = require('./orderAutomationService');
const { round2, computeOrderTotals } = require('./orderTotals');
const { unitPrice } = require('../utils/variantAdapter');

const FLAG_KEY = 'smart_shipping';
const RATES_KEY = 'shipping_rates';
const FALLBACK = 'A coordinar';

async function readJsonSetting(key) {
  try {
    const row = await models.AppSetting.findOne({ where: { key } });
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

async function getConfig() {
  const v = await readJsonSetting(FLAG_KEY);
  const enabled = v?.enabled === true;
  const mode = v?.policy?.mode === 'absorb' ? 'absorb' : 'excess';
  const mult = Number(v?.policy?.multiplier);
  return {
    enabled,
    adapter: ['dropiTable', 'mock'].includes(v?.adapter) ? v.adapter : 'dropiTable',
    ttlMinutes: Number.isInteger(v?.ttlMinutes) && v.ttlMinutes > 0 && v.ttlMinutes <= 60 ? v.ttlMinutes : 15,
    policy: { mode, multiplier: Number.isFinite(mult) && mult >= 1 && mult <= 2 ? mult : 1 },
  };
}

const ceil2 = (n) => Math.ceil(round2(n) * 100 - 1e-9) / 100;
function surchargeFor(option, policy) {
  if (policy.mode === 'absorb') return 0;
  return ceil2(Math.max(0, (option.cost - option.included) * policy.multiplier));
}

// Huella del carrito: producto, variante, cantidad y precio vigente (todo leído de BD).
function cartHash(lines) {
  const norm = lines
    .map((l) => [l.productId, l.selectedDropiId ?? null, Number(l.qty), round2(l.price)])
    .sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])));
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

const lineFor = (item, product) => ({
  productId: product.id,
  selectedDropiId: item.selectedDropiId ?? null,
  qty: item.amount,
  price: unitPrice(product, item.selectedDropiId),
  dropiId: item.selectedDropiId || product.dropiProductId || null,
});

async function resolveCity(city, department) {
  const n = automation.norm(city);
  if (!n) return null;
  const c = (await automation.knownCities()).find((x) => automation.norm(x.name) === n);
  if (!c) return null;
  if (department && c.department && automation.norm(department) !== automation.norm(c.department)) return null;
  return c;
}

// Opciones con precio de política. Errores del adaptador → sin opciones (nunca al cliente).
async function computeOptions(cfg, lines, cityId, paymentMethod) {
  if (!lines.length || lines.some((l) => !l.dropiId)) return { options: [], source: cfg.adapter, ratesAsOf: null };
  const input = {
    items: lines.map((l) => ({ dropiId: l.dropiId, qty: l.qty, declaredPrice: l.price })),
    cityId,
    cod: paymentMethod === 'cod',
  };
  let raw = [];
  let ratesAsOf = null;
  try {
    if (cfg.adapter === 'mock') {
      raw = adapters.mock(input);
    } else {
      // En producción la tabla SOLO sale de app_settings; la semilla es para dev/test.
      const table = (await readJsonSetting(RATES_KEY)) || (process.env.NODE_ENV === 'production' ? null : adapters.SEED_RATES);
      raw = table ? adapters.dropiTable(input, table) : [];
      ratesAsOf = table?.asOf ?? null;
    }
  } catch (e) {
    console.error(`[shipping] adaptador ${cfg.adapter} falló: ${e.message}`);
    raw = [];
  }
  const options = raw
    .filter((o) => Number.isFinite(o.cost) && o.cost >= 0 && Number.isFinite(o.included))
    .map((o) => ({
      optionId: `c${o.carrierId}`,
      carrierId: o.carrierId,
      carrierName: o.carrierName,
      cost: round2(o.cost),
      surcharge: surchargeFor(o, cfg.policy),
      eta: o.eta || null,
      restrictions: o.restrictions || [],
    }))
    .sort((a, b) => a.surcharge - b.surcharge || a.cost - b.cost);
  return { options, source: cfg.adapter, ratesAsOf };
}

function conflict(code, message) {
  const err = boom.conflict(message);
  err.output.payload.code = code;
  return err;
}

/**
 * POST /api/v1/shipping/quotes. Precios, cantidades y productos se leen de BD.
 * @returns {{enabled:boolean, quoteId?:string, expiresAt?:string, currency:'USD', subtotal?:number,
 *            options:Array, fallback:string|null}}
 */
async function createQuote({ orderId, userId, city, department, paymentMethod }) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { enabled: false, currency: 'USD', options: [], fallback: FALLBACK };

  const order = await models.Order.findByPk(orderId);
  if (!order) throw boom.notFound('Orden no encontrada');
  const customer = order.customerId ? await models.Customer.findByPk(order.customerId, { attributes: ['id', 'userId'] }) : null;
  if (!customer || customer.userId !== userId) throw boom.forbidden('Esta orden no te pertenece');
  if (order.state !== 'carrito') throw boom.conflict(`La orden no se puede cotizar (estado: ${order.state})`);

  const items = await models.OrderProduct.findAll({ where: { orderId: order.id } });
  if (!items.length) throw boom.badRequest('No puedes cotizar un carrito vacío');
  const products = await models.Product.findAll({ where: { id: items.map((i) => i.productId), isDeleted: false } });
  const byId = new Map(products.map((p) => [p.id, p]));
  if (items.some((i) => !byId.has(i.productId))) throw boom.conflict('Un producto de la orden ya no está disponible.');
  const lines = items.map((i) => lineFor(i, byId.get(i.productId)));
  const { subtotal } = computeOrderTotals(lines);

  const c = await resolveCity(city, department);
  const { options, source, ratesAsOf } = c ? await computeOptions(cfg, lines, c.id, paymentMethod) : { options: [] };
  if (!options.length) return { enabled: true, currency: 'USD', subtotal, options: [], fallback: FALLBACK };

  const expiresAt = new Date(Date.now() + cfg.ttlMinutes * 60 * 1000);
  const q = await models.ShippingQuote.create({
    orderId: order.id, userId, cityKey: automation.norm(c.name), dropiCityId: c.id, paymentMethod,
    cartHash: cartHash(lines), options, source, ratesAsOf, expiresAt,
  });
  return {
    enabled: true,
    quoteId: q.id,
    expiresAt: expiresAt.toISOString(),
    currency: 'USD',
    subtotal,
    options: options.map((o) => ({
      optionId: o.optionId,
      carrierId: o.carrierId,
      carrierName: o.carrierName,
      quotedPrice: o.cost,
      currency: 'USD',
      surcharge: o.surcharge,
      total: round2(subtotal + o.surcharge),
      eta: o.eta,
      restrictions: o.restrictions,
    })),
    fallback: null,
  };
}

/**
 * Dentro de la transacción de confirmación (flag encendido). Valida y RECALCULA:
 * ajena, usada, vencida, huella o ciudad distinta, o precio cambiado → 409.
 * Marca la cotización como usada. Devuelve lo que se persiste en la orden.
 */
async function applyQuote({ t, order, userId, quoteId, optionId, paymentMethod, lines, cfg }) {
  if (!quoteId || !optionId) throw boom.badRequest('Falta la cotización de envío (quoteId y optionId)');
  const q = await models.ShippingQuote.findByPk(quoteId, { lock: t.LOCK.UPDATE, transaction: t });
  if (!q || q.orderId !== order.id || q.userId !== userId) throw conflict('SHIPPING_QUOTE_INVALID', 'La cotización de envío no corresponde a este pedido');
  if (q.usedAt) throw conflict('SHIPPING_QUOTE_USED', 'La cotización de envío ya se usó');
  if (new Date(q.expiresAt).getTime() <= Date.now()) throw conflict('SHIPPING_QUOTE_EXPIRED', 'La cotización de envío venció; vuelve a cotizar');
  // paymentMethod null (checkout(): DeUna o créditos parciales) → vale el de la cotización.
  if (paymentMethod && q.paymentMethod !== paymentMethod) throw conflict('SHIPPING_QUOTE_INVALID', 'La cotización de envío es de otro método de pago');
  if (q.cartHash !== cartHash(lines)) throw conflict('SHIPPING_CHANGED', 'Tu carrito cambió; vuelve a cotizar el envío');

  // La ciudad de entrega (la que usa el despacho) debe ser la cotizada.
  const customer = await models.Customer.findByPk(order.customerId, { attributes: ['id', 'city', 'province'], transaction: t });
  const city = await resolveCity(customer?.city);
  if (!city || city.id !== q.dropiCityId) throw conflict('SHIPPING_CITY_MISMATCH', 'La ciudad de entrega no coincide con la cotizada');

  const stored = (q.options || []).find((o) => o.optionId === optionId);
  const fresh = (await computeOptions(cfg, lines, q.dropiCityId, q.paymentMethod)).options.find((o) => o.optionId === optionId);
  if (!stored || !fresh || fresh.surcharge !== stored.surcharge) {
    throw conflict('SHIPPING_CHANGED', 'El costo de envío cambió; vuelve a cotizar');
  }
  await q.update({ usedAt: new Date() }, { transaction: t });
  return { quoteId: q.id, carrierId: fresh.carrierId, carrierName: fresh.carrierName, charge: fresh.surcharge, cost: fresh.cost };
}

/** Créditos parciales + COD: la cotización fijada en checkout() debe ser contra entrega. */
async function assertUsedQuoteMethod(t, orderId, paymentMethod) {
  // Sin cotización usada (checkout() antes de encender el flag) → no se bloquea.
  const q = await models.ShippingQuote.findOne({ where: { orderId, usedAt: { [Op.ne]: null } }, transaction: t });
  if (q && q.paymentMethod !== paymentMethod) {
    throw conflict('SHIPPING_QUOTE_INVALID', 'El envío de este pedido se cotizó para otro método de pago');
  }
}

/** Persiste las columnas de envío (no declaradas en orderModel: con el flag apagado nada cambia). */
async function persistOnOrder(t, orderId, s) {
  await models.Order.sequelize.query(
    'UPDATE "orders" SET "shipping_quote_id" = :q, "shipping_carrier_id" = :c, "shipping_charge" = :ch, "shipping_cost_quoted" = :cost WHERE "id" = :id',
    { replacements: { q: s.quoteId, c: s.carrierId, ch: s.charge, cost: s.cost, id: orderId }, transaction: t }
  );
}

module.exports = { getConfig, createQuote, applyQuote, assertUsedQuoteMethod, persistOnOrder, cartHash, lineFor, surchargeFor, FALLBACK };
