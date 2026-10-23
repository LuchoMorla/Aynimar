'use strict';
/* eslint-disable no-console */

/**
 * Automatización de pedidos hacia Dropi — reglas, excepciones y conciliación.
 * Contrato y plan de activación: docs/ORDER_AUTOMATION.md.
 *
 * Lo llama OrderService._dispatchOrder ANTES de enviar nada a Dropi:
 *   preDispatch(order) → null (adelante) | { status } (no se envía).
 * Nunca sustituye productos ni cambia precios: si algo no cuadra, abre una
 * excepción (order_exceptions) para revisión humana.
 */

const boom = require('@hapi/boom');
const { QueryTypes, Op } = require('sequelize');
const sequelize = require('../libs/sequelize');
const { contributionPerOrder } = require('./financeContribution');
const { isProductionEnv, signCallbackData } = require('../libs/telegramSecurity');
const { sendTelegramNotification, callTelegram } = require('../utils/telegramNotify');
const { getAdminChatId } = require('../libs/telegramSecurity');
const dropi = require('../integrations/dropi/dropiAdapter');
const { unitPrice, variantQty, selectedVariant } = require('../utils/variantAdapter');

const { models } = sequelize;
const sel = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

// ── Configuración (todo por variable de entorno; valores por defecto = staging) ──
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
function range(v, d) {
  const parts = String(v ?? d).split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return d.split(':').map(Number);
  return parts.length === 1 ? [parts[0], parts[0]] : [parts[0], parts[1]];
}
function getConfig(env = process.env) {
  let mode = String(env.DROPI_ORDER_AUTOMATION || 'off').toLowerCase();
  if (!['off', 'supervised', 'auto'].includes(mode)) mode = 'off';
  // CEO-004: piloto = operador manual. 'auto' exige además su propio flag (apagado por defecto).
  if (mode === 'auto' && env.DROPI_ORDER_AUTO_ENABLED !== 'true') mode = 'supervised';
  return {
    mode,
    // CEO-004: tope diario de órdenes REALES enviadas (día de Ecuador). Al superarlo → excepción daily_cap_reached.
    dailyCap: Math.max(0, Math.floor(num(env.ORDER_DAILY_DISPATCH_CAP, 5))),
    supervisedMin: Math.max(0, Math.floor(num(env.DROPI_ORDER_SUPERVISED_MIN, 20))),
    maxQty: Math.max(1, Math.floor(num(env.ORDER_MAX_QTY_PER_LINE, 10))),
    duplicateWindowH: num(env.ORDER_DUPLICATE_WINDOW_HOURS, 24),
    stuckSendingMin: num(env.ORDER_SENDING_TIMEOUT_MIN, 10),
    // Pisos de margen (configurables). Contribución esperada con rejectRate de rechazo
    // ≥ max(minContribution, minMarginOnNet × venta neta esperada).
    //  - pilotFloor: mientras el pedido requiere confirmación (piloto supervisado). Decisión del propietario: ≥ USD 1.
    //  - autoFloor:  envío automático sin confirmación. Propuesta CEO-003: ≥ USD 5 y ≥ 15 % (PROVISIONAL).
    pilotFloor: { minContribution: num(env.ORDER_PILOT_MIN_CONTRIBUTION_USD, 1), minMarginOnNet: num(env.ORDER_PILOT_MIN_MARGIN_ON_NET, 0) },
    autoFloor: { minContribution: num(env.ORDER_AUTO_MIN_CONTRIBUTION_USD, 5), minMarginOnNet: num(env.ORDER_AUTO_MIN_MARGIN_ON_NET, 0.15) },
    margin: {
      rejectRate: Math.min(1, num(env.ORDER_MARGIN_REJECT_RATE, 0.30)),
      shipping: range(env.ORDER_SHIPPING_COST_USD, '3.5:6'),
      returnCost: range(env.ORDER_RETURN_COST_USD, '3.5:6'),
      commissionRate: range(env.ORDER_COD_COMMISSION_RATE, '0:0.05'),
    },
  };
}

const EXCEPTION_TYPES = [
  'out_of_stock', 'incomplete_address', 'missing_dropi_id', 'variant_mismatch', 'margin_insufficient',
  'possible_duplicate', 'inconsistent_data', 'provider_error', 'dispatch_unknown', 'unknown_status',
  'delivery_issue', 'cod_unreconciled', 'held_by_supervisor', 'cancelled_after_dispatch', 'daily_cap_reached',
  // Producto sin proveedor Dropi confirmado → cola de ABASTECIMIENTO MANUAL (nunca se envía a Dropi).
  // Sustituye a missing_dropi_id para los productos; missing_dropi_id sigue para el supplier_id sin
  // verificar (dato técnico de configuración) y para las excepciones abiertas antes del cambio.
  'sourcing_required',
];
// No bloquean el envío: avisan de algo que ya ocurrió (estado, entrega, cobro, cancelación tardía).
const NON_BLOCKING = ['unknown_status', 'delivery_issue', 'cod_unreconciled', 'cancelled_after_dispatch'];
// Resoluciones admitidas por tipo (POST /order-exceptions/:id/resolve).
const RESOLUTIONS = {
  retry: EXCEPTION_TYPES.filter((t) => !['dispatch_unknown', 'cod_unreconciled', 'cancelled_after_dispatch'].includes(t)),
  // accept en unknown_status/delivery_issue/cancelled_after_dispatch = "revisado" (solo registra costes).
  // sourcing_required no admite accept: sin proveedor confirmado no hay nada que enviar.
  accept: ['margin_insufficient', 'possible_duplicate', 'inconsistent_data', 'incomplete_address', 'held_by_supervisor', 'unknown_status', 'delivery_issue', 'cancelled_after_dispatch'],
  manual: EXCEPTION_TYPES.filter((t) => !['cod_unreconciled', 'cancelled_after_dispatch'].includes(t)),
  link: ['dispatch_unknown', 'provider_error'],
  not_created: ['dispatch_unknown'],
  collected: ['cod_unreconciled'],
  not_collected: ['cod_unreconciled'],
};
// Excepciones que impiden el envío mientras estén abiertas.
const BLOCKING_TYPES = EXCEPTION_TYPES.filter((t) => !NON_BLOCKING.includes(t));

// ── Excepciones ──────────────────────────────────────────────────────────────
/** Abre (o actualiza) la excepción abierta (order, type). Idempotente. @returns {boolean} true si es nueva. */
async function openException(orderId, type, details = {}) {
  if (!EXCEPTION_TYPES.includes(type)) throw new Error(`tipo de excepción desconocido: ${type}`);
  const rows = await sel(`
    INSERT INTO order_exceptions (order_id, type, details, status, created_at, updated_at)
    VALUES (:orderId, :type, CAST(:details AS jsonb), 'open', now(), now())
    ON CONFLICT (order_id, type) WHERE status = 'open'
    DO UPDATE SET details = EXCLUDED.details, updated_at = now()
    RETURNING (xmax = 0) AS inserted`, { orderId, type, details: JSON.stringify(details) });
  return Boolean(rows[0]?.inserted);
}

async function openExceptionTypes(orderId) {
  const rows = await sel("SELECT type FROM order_exceptions WHERE order_id = :orderId AND status = 'open'", { orderId });
  return rows.map((r) => r.type);
}

async function acceptedTypes(orderId) {
  const rows = await sel("SELECT DISTINCT type FROM order_exceptions WHERE order_id = :orderId AND status = 'resolved' AND resolution = 'accept'", { orderId });
  return new Set(rows.map((r) => r.type));
}

async function listExceptions({ status = 'open', type, limit = 100 } = {}) {
  const where = [];
  if (status !== 'all') where.push('e.status = :status');
  if (type) where.push('e.type = :type');
  return sel(`
    SELECT e.id, e.order_id AS "orderId", e.type, e.details, e.status, e.resolution, e.note,
           e.resolved_by AS "resolvedBy", e.resolved_at AS "resolvedAt", e.created_at AS "createdAt",
           o.total, o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
           o.state_order AS "stateOrder", o.fulfillment_status AS "fulfillmentStatus",
           o.dropi_order_id AS "dropiOrderId", o.cod_status AS "codStatus", o.is_test AS "isTest"
      FROM order_exceptions e JOIN orders o ON o.id = e.order_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT :limit`, { status, type, limit: Math.min(500, Math.max(1, Number(limit) || 100)) });
}

// ── Salud del catálogo (rama feat/catalog-health) — interfaz desacoplada ─────
// Tipos de catalog_issues que bloquean el envío y la excepción a la que se traducen.
const CATALOG_BLOCKING = {
  dropi_not_found: 'sourcing_required',
  missing_dropi_id: 'sourcing_required',
  dropi_out_of_stock: 'out_of_stock',
  negative_margin: 'margin_insufficient',
  missing_cost: 'margin_insufficient',
};
let catalogTableWarned = false;
/**
 * Issues abiertos bloqueantes por producto. Fallback seguro: si la tabla
 * catalog_issues aún no existe (rama no desplegada) devuelve [] — las
 * validaciones propias (ID Dropi, variante, coste/margen) siguen aplicando.
 * @returns {Promise<Array<{productId:number, type:string}>>}
 */
async function blockingCatalogIssues(productIds) {
  if (!productIds.length) return [];
  try {
    return await sel(`SELECT product_id AS "productId", type FROM catalog_issues
                       WHERE status = 'open' AND product_id IN (:productIds) AND type IN (:types)`,
    { productIds, types: Object.keys(CATALOG_BLOCKING) });
  } catch (err) {
    if (err.original?.code === '42P01' || err.parent?.code === '42P01') {
      if (!catalogTableWarned) console.warn('[OrderAutomation] catalog_issues no existe todavía: se omiten esos bloqueos.');
      catalogTableWarned = true;
      return [];
    }
    throw err;
  }
}
async function hasBlockingIssue(productId) {
  return (await blockingCatalogIssues([productId])).length > 0;
}

// ── Abastecimiento manual (sourcing_required) ────────────────────────────────
// Candidatos de supplier_candidates (rama feat/catalog-health). Sin tabla → [] (fallback seguro).
const CLASS_RANK = { EXACTO: 0, SIMILAR: 1, DISTINTO: 2 };
const STATUS_RANK = { preparado_preferente: 0, aprobado_por_propietario: 1, propuesto: 2 };
async function sourcingCandidates(productIds) {
  if (!productIds.length) return [];
  try {
    const rows = await sel(`SELECT id, product_id AS "productId", dropi_product_id AS "dropiProductId", dropi_variation_id AS "dropiVariationId",
        name, cost::float AS cost, stock, classification, status FROM supplier_candidates
       WHERE product_id IN (:productIds) AND status <> 'descartado'`, { productIds });
    return rows.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
      || (CLASS_RANK[a.classification] ?? 9) - (CLASS_RANK[b.classification] ?? 9) || (a.cost ?? 1e9) - (b.cost ?? 1e9) || a.id - b.id);
  } catch (err) {
    if (err.original?.code === '42P01' || err.parent?.code === '42P01') return [];
    throw err;
  }
}

/**
 * Borradores de aviso al cliente. NUNCA se envían solos (sent:false): el operador elige uno.
 * Sin datos personales: el nombre va como marcador {{nombre_cliente}}.
 * Un artículo distinto es una SUSTITUCIÓN y solo se envía si el cliente la acepta.
 */
function customerNotice(order, productNames, { identical = false, alternatives = false } = {}) {
  const ref = `AYNIMAR-${order.id}`;
  const prod = productNames.map((n) => `«${n}»`).join(', ') || 'tu producto';
  const paid = order.paymentStatus === 'paid';
  const hi = `Hola {{nombre_cliente}}, gracias por tu pedido ${ref}.`;
  const options = [
    { kind: 'retraso', requiresCustomerAcceptance: false,
      text: `${hi} ${prod} está tardando más de lo previsto con nuestro proveedor. Te escribiremos en cuanto tengamos la fecha de despacho. Si prefieres no esperar, puedes cancelar sin ningún costo.` },
  ];
  if (identical) {
    options.push({ kind: 'alternativa_identica', requiresCustomerAcceptance: false,
      text: `${hi} Vamos a despachar ${prod} desde otro proveedor: es el mismo artículo, al mismo precio. Puede tardar {{dias}} días más. Si prefieres cancelar, avísanos.` });
  }
  if (alternatives) {
    options.push({ kind: 'sustitucion', requiresCustomerAcceptance: true,
      text: `${hi} No podemos garantizar ${prod} tal como aparece en la tienda. Te proponemos esta alternativa: {{descripcion_alternativa}} (diferencias: {{diferencias}}). Solo la enviaremos si nos respondes que la aceptas; si no, cancelamos el pedido${paid ? ' y te devolvemos el importe' : ' sin ningún cobro'}.` });
  }
  options.push({ kind: 'reembolso', requiresCustomerAcceptance: false,
    text: paid
      ? `${hi} Lo sentimos: no podremos entregar ${prod}. Cancelamos el pedido y te devolvemos el importe pagado en {{plazo_reembolso}}.`
      : `${hi} Lo sentimos: no podremos entregar ${prod}. Cancelamos el pedido; como es pago contra entrega, no se te cobrará nada.` });
  return { sent: false, autoSend: false, note: 'Borradores para el operador: nada se envía automáticamente. Sustituir por un artículo distinto requiere la aceptación del cliente.', options };
}

/** Detalle de la excepción: acción sugerida, candidatos y aviso al cliente por producto. */
async function sourcingInfo(order, details) {
  const ids = [...new Set(details.map((d) => d.productId).filter(Boolean))];
  const cands = await sourcingCandidates(ids);
  const names = new Map((order.items || []).map((i) => [i.id, i.name]));
  const products = ids.map((productId) => {
    const list = cands.filter((c) => c.productId === productId).slice(0, 5);
    const preferred = list.find((c) => ['preparado_preferente', 'aprobado_por_propietario'].includes(c.status) && c.classification === 'EXACTO');
    const suggestedAction = preferred
      ? `Hay un proveedor alternativo con el MISMO artículo (Dropi ${preferred.dropiProductId}, ${preferred.status}). El propietario puede vincularlo en Salud del catálogo (swap_dropi_id) y después reintentar (retry). No se aplica solo.`
      : list.length
        ? 'Hay candidatos, pero ninguno confirmado como idéntico: abastecer a mano (manual) o avisar al cliente. Un artículo distinto requiere su aceptación.'
        : 'Sin candidatos: abastecimiento manual (manual) o avisar al cliente (retraso o reembolso).';
    return { productId, productName: names.get(productId) ?? null, suggestedAction, candidates: list, identical: Boolean(preferred) };
  });
  const notice = customerNotice(order, products.map((p) => p.productName).filter(Boolean), {
    identical: products.length > 0 && products.every((p) => p.identical),
    alternatives: products.some((p) => p.candidates.length > 0),
  });
  return { queue: 'abastecimiento_manual', products, customerNotice: notice };
}

/** Abre (o actualiza) la excepción sourcing_required. @returns {boolean} true si es nueva. */
async function openSourcing(order, details) {
  return openException(order.id, 'sourcing_required', { problems: details, ...(await sourcingInfo(order, details)) });
}

/** Solo la parte de abastecimiento (para el modo off, que no valida nada más). */
async function sourcingProblems(order) {
  // Productos con otro proveedor propio (p. ej. effi) no son «sin proveedor»: el modo off no los toca.
  const own0 = (order.items || []).filter((i) => !i.sourceProvider || i.sourceProvider === 'dropi');
  const { problems } = buildDropiLines({ ...order, items: own0 });
  const own = problems.filter((p) => p.type === 'sourcing_required').map((p) => p.details);
  for (const i of await blockingCatalogIssues(own0.map((x) => x.id))) {
    if (CATALOG_BLOCKING[i.type] === 'sourcing_required') own.push({ productId: i.productId, catalogIssue: i.type });
  }
  return own;
}

// ── Ciudades Dropi ───────────────────────────────────────────────────────────
// El backend no puede llamar a search_cities (solo existe en el conector MCP).
// Lista verificada con search_cities (2026-10-20) + las que un operador añade al
// resolver una excepción incomplete_address (AppSetting dropi_cities).
// stateCode = código de provincia del plugin oficial (states/EC.php + places/EC.php).
const CITY_KEY = 'dropi_cities';
const SEED_CITIES = [
  { id: 802, name: 'QUITO', departmentId: 43, department: 'PICHINCHA', stateCode: 'EC-P' },
  { id: 732, name: 'GUAYAQUIL', departmentId: 44, department: 'GUAYAS', stateCode: 'EC-G' },
];
// Formato de `state` que espera la API (SIN CONFIRMAR por Dropi):
//   code (por defecto) = lo que envía el plugin oficial (EC-P) · name = PICHINCHA.
// city va siempre en mayúsculas, como en places/EC.php. Sin el dato verificado → bloqueo.
const stateFormat = (env = process.env) => (String(env.DROPI_ORDER_STATE_FORMAT || 'code').toLowerCase() === 'name' ? 'name' : 'code');
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\r\n\t]/g, ' ')
  .replace(/\s+/g, ' ').trim().toUpperCase();
async function knownCities() {
  const row = await models.AppSetting.findOne({ where: { key: CITY_KEY } }).catch(() => null);
  let extra = [];
  try { extra = JSON.parse(row?.value || '[]'); } catch { extra = []; }
  return [...SEED_CITIES, ...(Array.isArray(extra) ? extra : [])];
}
const SUPPLIER_KEY = 'dropi_suppliers';
async function knownSuppliers() {
  const row = await models.AppSetting.findOne({ where: { key: SUPPLIER_KEY } }).catch(() => null);
  try { const v = JSON.parse(row?.value || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
async function addCity(city) {
  const c = { id: Number(city?.id), name: norm(city?.name), departmentId: Number(city?.departmentId) || null, department: norm(city?.department) || null, stateCode: norm(city?.stateCode) || null };
  if (!Number.isInteger(c.id) || c.id < 1 || !c.name) throw boom.badRequest('dropiCity requiere id (entero) y name, de search_cities');
  if (c.stateCode && !/^EC-[A-Z]$/.test(c.stateCode)) throw boom.badRequest('dropiCity.stateCode debe ser un código EC-X del plugin oficial');
  const row = await models.AppSetting.findOne({ where: { key: CITY_KEY } });
  let list = [];
  try { list = JSON.parse(row?.value || '[]'); } catch { list = []; }
  list = list.filter((x) => norm(x.name) !== c.name).concat(c);
  await models.AppSetting.upsert({ key: CITY_KEY, value: JSON.stringify(list), updatedAt: new Date() });
  return c;
}

// ── Validación previa ────────────────────────────────────────────────────────
const TEST_EMAIL_RE = /(^qa\+)|@(example\.(com|org|net)|test\.[a-z]+|mailinator\.com)$/i;
function normalizePhoneEC(raw) {
  let d = String(raw ?? '').replace(/[\s().-]/g, '');
  if (d.startsWith('+593')) d = `0${d.slice(4)}`;
  else if (d.startsWith('593') && d.length === 12) d = `0${d.slice(3)}`;
  if (/^9\d{8}$/.test(d)) d = `0${d}`;
  return /^0\d{9}$/.test(d) || /^0[2-7]\d{7}$/.test(d) ? d : null;
}
const isDropiId = (v) => /^\d{1,12}$/.test(String(v ?? '').trim()) && Number(v) >= 1;

/** Líneas Dropi del pedido (sin sustituir nada). @returns {{lines, problems}} */
function buildDropiLines(order) {
  const lines = [];
  const problems = [];
  const items = order.items || [];
  const isDropiItem = (it) => Boolean(it.dropiProductId) || it.sourceProvider === 'dropi' || (Array.isArray(it.dropiItems) && it.dropiItems.length > 0);
  for (const it of items) {
    const qty = it.OrderProduct?.amount;
    const price = Number(it.OrderProduct?.unitPriceGross ?? unitPrice(it, it.OrderProduct?.selectedDropiId));
    const productId = it.dropiProductId || (it.sourceProvider === 'dropi' ? it.externalId : null);
    if (!isDropiItem(it)) {
      problems.push({ type: 'sourcing_required', details: { productId: it.id, reason: 'producto sin vínculo Dropi en un pedido Dropi' } });
      continue;
    }
    const dropiItems = Array.isArray(it.dropiItems) ? it.dropiItems : [];
    if (it.isBundle === true && dropiItems.length > 0) {
      dropiItems.forEach((b, i) => {
        if (!isDropiId(b?.id)) problems.push({ type: 'sourcing_required', details: { productId: it.id, reason: `componente ${i} sin id Dropi válido` } });
        // El PVP del kit va en el primer componente (Dropi exige precio ≥ 0 por línea).
        lines.push({ productId: it.id, id: Number(b?.id), name: it.name, quantity: (b?.qty ?? 1) * qty, price: i === 0 ? price : 0 });
      });
      continue;
    }
    if (!isDropiId(productId)) {
      problems.push({ type: 'sourcing_required', details: { productId: it.id, reason: 'dropiProductId ausente o no numérico' } });
      continue;
    }
    let variationId = null;
    if (dropiItems.length > 0) {
      const sel = it.OrderProduct?.selectedDropiId ?? (dropiItems.length === 1 ? dropiItems[0]?.id : null);
      const entry = sel ? selectedVariant(it, sel) : null;
      if (!sel) problems.push({ type: 'variant_mismatch', details: { productId: it.id, reason: 'variante no elegida (no se usa la primera por defecto)' } });
      else if (!entry) problems.push({ type: 'variant_mismatch', details: { productId: it.id, selectedDropiId: String(sel), reason: 'la variante elegida ya no existe en el producto' } });
      else if (entry.dropiId != null) {
        // Presentación («1 unidad», «Pack x2»): producto Dropi SIMPLE × qty de la variante.
        // El precio se reparte por unidad Dropi para que precio × cantidad = PVP de la línea.
        if (!isDropiId(entry.dropiId)) problems.push({ type: 'sourcing_required', details: { productId: it.id, reason: `presentación ${sel} sin id Dropi válido` } });
        const k = variantQty(it, sel);
        lines.push({ productId: it.id, id: Number(entry.dropiId), name: it.name, quantity: k * qty, price: price / k, variationId: null });
        continue;
      }
      else if (!isDropiId(sel)) problems.push({ type: 'variant_mismatch', details: { productId: it.id, selectedDropiId: String(sel), reason: 'id de variante no numérico' } });
      else variationId = Number(sel);
    }
    lines.push({ productId: it.id, id: Number(productId), name: it.name, quantity: qty, price, variationId });
  }
  return { lines, problems };
}

/** Cliente → datos de envío en el formato del contrato oficial de Dropi. */
async function buildShipping(order) {
  const c = order.customer;
  const problems = [];
  if (!c) return { shipping: null, problems: [{ type: 'incomplete_address', details: { reason: 'pedido sin cliente' } }] };
  const missing = [];
  if (!String(c.name ?? '').trim()) missing.push('nombre');
  if (!String(c.lastName ?? '').trim()) missing.push('apellido');
  if (String(c.streetAddress ?? '').trim().length < 6) missing.push('dirección');
  const phone = normalizePhoneEC(c.phone) || normalizePhoneEC(c.phoneTwo);
  if (!phone) missing.push('teléfono válido de Ecuador');
  const cities = await knownCities();
  const city = cities.find((x) => norm(x.name) === norm(c.city));
  const fmt = stateFormat();
  const state = city ? (fmt === 'code' ? city.stateCode : city.department) || null : null;
  if (!city) missing.push('ciudad verificada en Dropi');
  else if (!state) missing.push(`provincia verificada (${fmt === 'code' ? 'stateCode EC-X' : 'department'}) para ${city.name}`);
  if (missing.length) problems.push({ type: 'incomplete_address', details: { missing } });
  return {
    problems,
    shipping: {
      name: String(c.name ?? '').trim(),
      surname: String(c.lastName ?? '').trim(),
      dir: String(c.streetAddress ?? '').trim(),
      city: city?.name ?? null,
      cityId: city?.id ?? null,
      state,
      phone,
      email: c.user?.email || undefined,
      dni: c.identityNumber ? String(c.identityNumber) : undefined,
    },
  };
}

function marginCheck(order, cfg, floorCfg) {
  const items = order.items || [];
  let gross = 0;
  let cost = 0;
  const noCost = [];
  for (const it of items) {
    const qty = it.OrderProduct?.amount ?? 0;
    const sel = it.OrderProduct?.selectedDropiId;
    gross += Number(it.OrderProduct?.unitPriceGross ?? unitPrice(it, sel)) * qty;
    const c = it.OrderProduct?.unitCostSnapshot ?? it.costPrice;
    if (c === null || c === undefined || !(Number(c) > 0)) noCost.push(it.id);
    else cost += Number(c) * variantQty(it, sel) * qty; // Pack x2 = 2 × coste unitario
  }
  if (noCost.length) return { type: 'margin_insufficient', details: { reason: 'coste de proveedor desconocido', productIds: noCost } };
  if (!(gross > 0)) return { type: 'inconsistent_data', details: { reason: 'importe del pedido ≤ 0' } };
  const m = cfg.margin;
  const r = contributionPerOrder({
    pvp: Math.round(gross * 100) / 100, qty: 1, cost: Math.round(cost * 100) / 100, costIncludesVat: null,
    shipping: null, returnCost: null, commissionRate: null,
    deliveryRate: 1 - m.rejectRate, returnRate: m.rejectRate,
    assumptions: { shipping: m.shipping, returnCost: m.returnCost, commissionRate: m.commissionRate },
  });
  const floor = Math.max(floorCfg.minContribution, floorCfg.minMarginOnNet * (r.netRevenue ?? 0));
  if (r.incomplete || r.contribution < floor) {
    return {
      type: 'margin_insufficient',
      details: { floorName: floorCfg.name, contributionWorst: r.contribution, floor: Math.round(floor * 100) / 100, netRevenue: r.netRevenue, rejectRate: m.rejectRate, missing: r.missing },
    };
  }
  return null;
}

async function possibleDuplicate(order, cfg) {
  if (!order.customerId) return null;
  const mine = (order.items || []).map((i) => `${i.id}x${i.OrderProduct?.amount}`).sort().join(',');
  const since = new Date(Date.now() - cfg.duplicateWindowH * 3600 * 1000);
  const others = await models.Order.findAll({
    where: {
      customerId: order.customerId, id: { [Op.ne]: order.id }, state: { [Op.ne]: 'carrito' },
      stateOrder: { [Op.ne]: 'cancelado' }, confirmedAt: { [Op.gte]: since },
    },
    include: ['items'],
  });
  const dup = others.find((o) => (o.items || []).map((i) => `${i.id}x${i.OrderProduct?.amount}`).sort().join(',') === mine);
  return dup ? { type: 'possible_duplicate', details: { otherOrderId: dup.id, windowHours: cfg.duplicateWindowH } } : null;
}

/** Todas las comprobaciones. @returns {Promise<{problems, payload}>} payload listo para createOrderInDropi. */
async function validateOrder(order, cfg = getConfig(), floor = 'autoFloor') {
  const problems = [];
  const items = order.items || [];
  if (!items.length) problems.push({ type: 'inconsistent_data', details: { reason: 'pedido sin líneas' } });
  for (const it of items) {
    const qty = it.OrderProduct?.amount;
    if (!Number.isInteger(qty) || qty < 1 || qty > cfg.maxQty) problems.push({ type: 'inconsistent_data', details: { productId: it.id, reason: `cantidad fuera de rango (${qty}; máx ${cfg.maxQty})` } });
    if (it.isDeleted) problems.push({ type: 'out_of_stock', details: { productId: it.id, reason: 'producto eliminado del catálogo' } });
  }
  const { lines, problems: lineProblems } = buildDropiLines(order);
  problems.push(...lineProblems);
  const { shipping, problems: shipProblems } = await buildShipping(order);
  problems.push(...shipProblems);

  const pm = order.paymentMethod;
  let rateType = null;
  if (pm === 'cod' && order.paymentStatus === 'pending') rateType = 'CON RECAUDO';
  else if (order.paymentStatus === 'paid') rateType = 'SIN RECAUDO';
  else problems.push({ type: 'inconsistent_data', details: { reason: `método/estado de pago no despachable (${pm}/${order.paymentStatus})` } });

  const linesTotal = Math.round(lines.reduce((s, l) => s + l.price * l.quantity, 0) * 100) / 100;
  if (rateType === 'CON RECAUDO' && Math.abs(linesTotal - Number(order.total)) > 0.01) {
    problems.push({ type: 'inconsistent_data', details: { reason: 'el importe a cobrar no coincide con las líneas', linesTotal, orderTotal: Number(order.total) } });
  }

  const margin = marginCheck(order, cfg, { name: floor, ...cfg[floor] });
  if (margin) problems.push(margin);

  for (const i of await blockingCatalogIssues(items.map((x) => x.id))) {
    problems.push({ type: CATALOG_BLOCKING[i.type], details: { productId: i.productId, catalogIssue: i.type } });
  }
  const dup = await possibleDuplicate(order, cfg);
  if (dup) problems.push(dup);

  // supplier_id (user_id del proveedor en Dropi) que exige el contrato oficial: tabla verificada
  // AppSetting dropi_suppliers = {"<id producto Dropi>": <user_id>}. Solo bloquea con transporte http.
  const suppliers = await knownSuppliers();
  const supplierIds = [...new Set(lines.map((l) => suppliers[String(l.id)]))];
  if (dropi.orderTransportName() === 'http') {
    const unknown = lines.filter((l) => !isDropiId(suppliers[String(l.id)])).map((l) => l.id);
    if (unknown.length) problems.push({ type: 'missing_dropi_id', details: { reason: 'proveedor Dropi (supplier_id) no verificado en dropi_suppliers', dropiProductIds: unknown } });
    else if (supplierIds.length > 1) problems.push({ type: 'inconsistent_data', details: { reason: 'pedido con varios proveedores Dropi (el contrato admite uno)', supplierIds } });
  }

  const payload = {
    shopOrderId: `AYNIMAR-${order.id}`,
    rateType,
    codAmount: rateType === 'CON RECAUDO' ? Number(order.total) : 0,
    supplierId: supplierIds.length === 1 && isDropiId(supplierIds[0]) ? Number(supplierIds[0]) : null,
    customer: shipping,
    products: lines.map(({ id, name, price, quantity, variationId }) => ({ id, name, price, quantity, ...(variationId ? { variation_id: variationId } : {}) })),
  };
  return { problems, payload };
}

/** Agrupa problemas por tipo (una excepción por tipo, con todos sus detalles). */
function groupProblems(problems) {
  const by = {};
  for (const p of problems) (by[p.type] = by[p.type] || []).push(p.details);
  return by;
}

// ── Puerta previa al envío ───────────────────────────────────────────────────

// Inicio del día en Ecuador (UTC-5, sin horario de verano).
function ecuadorDayStart(now = new Date()) {
  const ec = new Date(now.getTime() - 5 * 3600 * 1000);
  return new Date(Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate(), 5));
}
/** Órdenes reales enviadas (o en vuelo / resultado desconocido) hoy, sin contar `excludeId`. */
async function realDispatchedToday(excludeId = 0) {
  const [{ n }] = await sel(`SELECT count(*)::int AS n FROM orders
     WHERE is_test = false AND id <> :excludeId AND dispatch_started_at >= :since
       AND (fulfillment_status IN ('SENDING', 'DISPATCH_UNKNOWN')
            OR (dropi_order_id IS NOT NULL AND dropi_order_id NOT LIKE 'MOCK-%'))`,
  { excludeId, since: ecuadorDayStart() });
  return n;
}

async function realDispatchedCount() {
  const [{ n }] = await sel(`SELECT count(*)::int AS n FROM orders
     WHERE is_test = false AND dropi_order_id IS NOT NULL AND dropi_order_id NOT LIKE 'MOCK-%'`);
  return n;
}

// dropi_status_history = registro de eventos REALES del pedido ({status, group, at}): estados de
// Dropi + hitos propios (VALIDADO, ENVIADO_A_DROPI). Lo usa la barra de seguimiento (orderProgress).
function withEvent(order, status, group, extra = {}) {
  const h = Array.isArray(order.dropiStatusHistory) ? order.dropiStatusHistory : [];
  return [...h, { status, group, at: new Date().toISOString(), ...extra }].slice(-50);
}

async function setStatus(order, fulfillmentStatus, extra = {}) {
  await order.update({ fulfillmentStatus, ...extra });
}

async function notifyAdmin(text) {
  await sendTelegramNotification(text).catch(() => {});
}

// ── Aviso «pedido nuevo» al propietario (todos los caminos: COD, DeUna aprobado, créditos) ──
const PANEL_URL = 'https://circular-merchant.aynimar.com/';
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Prueba ≠ real: fuera de producción, marcado is_test o email de QA. */
function isTestOrder(order, prod = isProductionEnv()) {
  return Boolean(order.isTest) || !prod || TEST_EMAIL_RE.test(order.customer?.user?.email || '');
}

/** Texto del aviso: sin nombre, teléfono, correo ni dirección (solo la ciudad). */
function ownerOrderAlertText(order) {
  const units = (order.items || []).reduce((n, it) => n + (Number(it.OrderProduct?.amount) || 0), 0);
  return `🛒 <b>Pedido nuevo #${escHtml(order.id)}</b>\n` +
    `Total: $${escHtml(Number(order.total ?? 0).toFixed(2))} · ${units} ítem(s)\n` +
    `Ciudad: ${escHtml(order.customer?.city || '?')} · Pago: ${escHtml(order.paymentMethod || '?')}\n` +
    `Estado de envío: ${escHtml(order.fulfillmentStatus || '?')}\n` +
    `Panel: ${PANEL_URL}`;
}

/**
 * Un aviso por pedido real (claim atómico sobre owner_alerted_at). Nunca lanza:
 * si Telegram o la BD fallan, el pedido sigue igual.
 * ponytail: at-most-once — si Telegram falla tras el claim, ese aviso se pierde (queda en logs);
 * añadir reintento si se ve en la práctica.
 * @returns {Promise<boolean>} true si se envió (o intentó enviar) el aviso.
 */
async function notifyOwnerNewOrder(order, { prod = isProductionEnv() } = {}) {
  try {
    if (!order || isTestOrder(order, prod)) return false;
    const [claimed] = await models.Order.update({ ownerAlertedAt: new Date() }, { where: { id: order.id, ownerAlertedAt: null } });
    if (!claimed) return false;
    await sendTelegramNotification(ownerOrderAlertText(order));
    return true;
  } catch (err) {
    console.warn(`[OrderAutomation] aviso de pedido #${order?.id} no enviado: ${err.message}`);
    return false;
  }
}

/**
 * @returns {Promise<null | {status: string, problems?: object}>}
 *   null → se puede enviar (order.__dropiPayload queda preparado).
 */
async function preDispatch(order, cfg = getConfig()) {
  // Prueba ≠ real: fuera de producción o con email de QA, el pedido es de prueba.
  if (!order.isTest && isTestOrder(order)) await order.update({ isTest: true });
  if (cfg.mode === 'off') {
    // Aun con el interruptor apagado, un producto sin proveedor confirmado entra en la cola de
    // abastecimiento manual (decisión del propietario, 20-oct). No se envía nada a Dropi.
    const src = await sourcingProblems(order);
    if (src.length && (await openSourcing(order, src))) {
      await notifyAdmin(`📦 <b>Pedido #${order.id}: abastecimiento manual</b>\nProducto sin proveedor Dropi confirmado. No se envió a Dropi.\nRevisar: GET /api/v1/order-exceptions?type=sourcing_required`);
    }
    if (order.fulfillmentStatus !== 'AUTOMATION_OFF') await setStatus(order, 'AUTOMATION_OFF');
    return { status: 'AUTOMATION_OFF' };
  }
  if (order.stateOrder === 'cancelado') {
    await setStatus(order, 'CANCELLED');
    return { status: 'CANCELLED' };
  }

  // Transporte: mock (por defecto) o http. Prueba ≠ real en ambos sentidos.
  const blockTransport = async (reason) => {
    await openException(order.id, 'provider_error', { reason });
    await setStatus(order, 'BLOCKED');
    return { status: 'BLOCKED' };
  };
  if (dropi.orderTransportName() === 'mock') {
    // Un pedido REAL nunca se marca enviado con un id simulado (bug de da29068).
    if (isProductionEnv() && !order.isTest) return blockTransport('transporte de órdenes en mock en producción: el pedido real NO se envió');
  } else {
    if (order.isTest) { await setStatus(order, 'TEST_NOT_SENT'); return { status: 'TEST_NOT_SENT' }; }
    if (!isProductionEnv()) return blockTransport('Dropi real solo desde producción (usa el transporte mock)');
    // Host .co, /api/v1/orders o falta DROPI_INTEGRATION_KEY: no se reclama ni se llama a Dropi.
    const transportError = dropi.orderTransportError();
    if (transportError) return blockTransport(transportError);
  }

  // Modo supervisado: las primeras N órdenes reales (o todas en 'supervised') se confirman en
  // Telegram y se validan con el piso del piloto; el resto, con el piso automático.
  const supervisedPhase = cfg.mode === 'supervised' || (await realDispatchedCount()) < cfg.supervisedMin;
  const { problems, payload } = await validateOrder(order, cfg, supervisedPhase ? 'pilotFloor' : 'autoFloor');
  const accepted = await acceptedTypes(order.id);
  const grouped = groupProblems(problems.filter((p) => !accepted.has(p.type)));
  const stillOpen = (await openExceptionTypes(order.id)).filter((t) => BLOCKING_TYPES.includes(t) && !grouped[t]);
  if (Object.keys(grouped).length || stillOpen.length) {
    const fresh = [];
    for (const [type, details] of Object.entries(grouped)) {
      const isNew = type === 'sourcing_required' ? await openSourcing(order, details) : await openException(order.id, type, { problems: details });
      if (isNew) fresh.push(type);
    }
    await setStatus(order, 'BLOCKED');
    if (fresh.length) await notifyAdmin(`⚠️ <b>Pedido #${order.id} retenido</b> (no enviado a Dropi)\nExcepciones: ${fresh.join(', ')}\nRevisar: GET /api/v1/order-exceptions`);
    return { status: 'BLOCKED', problems: grouped };
  }

  if (!(order.dropiStatusHistory || []).some((h) => h.group === 'validated')) {
    await order.update({ dropiStatusHistory: withEvent(order, 'VALIDADO', 'validated') });
  }
  if (supervisedPhase && order.fulfillmentStatus !== 'CONFIRMED') {
    await setStatus(order, 'AWAITING_CONFIRMATION');
    await askConfirmation(order, payload);
    return { status: 'AWAITING_CONFIRMATION' };
  }
  // Tope diario (solo pedidos reales). ponytail: dos envíos simultáneos pueden pasarse en 1; lock si sube el volumen.
  if (!order.isTest) {
    const today = await realDispatchedToday(order.id);
    if (today >= cfg.dailyCap) {
      if (await openException(order.id, 'daily_cap_reached', { cap: cfg.dailyCap, sentToday: today, action: 'reintentar (retry) otro día o enviar a mano' })) {
        await notifyAdmin(`⏸️ <b>Pedido #${order.id} en cola</b>: tope diario de ${cfg.dailyCap} envíos reales a Dropi alcanzado.`);
      }
      await setStatus(order, 'BLOCKED');
      return { status: 'BLOCKED', problems: { daily_cap_reached: [{ cap: cfg.dailyCap, sentToday: today }] } };
    }
  }
  order.__dropiPayload = payload; // eslint-disable-line no-param-reassign
  return null;
}

async function askConfirmation(order, payload) {
  const ref = `o${order.id}`;
  const lines = payload.products.map((p) => `• Dropi ${p.id}${p.variation_id ? `/${p.variation_id}` : ''} ×${p.quantity} @ $${p.price}`).join('\n');
  const text = `🧾 Pedido #${order.id}${order.isTest ? ' (PRUEBA)' : ''} listo para Dropi\n${payload.rateType} · cobrar $${payload.codAmount}\n` +
    `Ciudad: ${payload.customer?.city ?? '?'}\n${lines}\nRef: ${ref}\n¿Enviar a Dropi?`;
  const buttons = [['ap', 'Enviar'], ['rj', 'Retener']].map(([a, t]) => ({ text: t, callback_data: signCallbackData(a, ref) }));
  if (!buttons.every((b) => b.callback_data) || !getAdminChatId()) {
    console.warn(`[OrderAutomation] Pedido #${order.id} espera confirmación pero Telegram no está configurado.`);
    return;
  }
  await callTelegram('sendMessage', { chat_id: getAdminChatId(), text, reply_markup: { inline_keyboard: [buttons] } });
}

/**
 * Botón firmado de Telegram (ref o<orderId>). verifyCallbackQuery ya validó admin + firma.
 * ap → CONFIRMED y envío; rj/ch → BLOCKED + excepción held_by_supervisor.
 */
async function handleTelegramCallback(cq, { action, ref }, answer) {
  const orderId = Number(ref.slice(1));
  const next = action === 'ap' ? 'CONFIRMED' : 'BLOCKED';
  const [n] = await models.Order.update({ fulfillmentStatus: next }, { where: { id: orderId, fulfillmentStatus: 'AWAITING_CONFIRMATION' } });
  if (!n) { await answer(cq.id, 'Ya decidido o no pendiente.'); return { changed: false }; }
  if (cq.message?.chat?.id && cq.message?.message_id) {
    await callTelegram('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if (next === 'BLOCKED') {
    await openException(orderId, 'held_by_supervisor', { by: 'telegram' });
    await answer(cq.id, 'Retenido');
    return { changed: true, status: 'BLOCKED' };
  }
  await answer(cq.id, 'Enviando a Dropi…');
  const OrderService = require('./orderService'); // diferido: evita require circular
  const svc = new OrderService();
  const r = await svc._dispatchOrder(await svc.findOne(orderId));
  await notifyAdmin(`Pedido #${orderId}: ${r.status}${r.dropiOrderId ? ` · Dropi ${r.dropiOrderId}` : ''}`);
  return { changed: true, status: r.status };
}

// ── Estados de Dropi → estado interno ────────────────────────────────────────
// Lista real de list_statuses (2026-10-20). Normalizada: mayúsculas, sin tildes ni \r\n.
// Las variantes de Laarcourier con la letra acentuada perdida ("EN TRNSITO") se cubren aparte.
const S = (s) => s.split('|').map(norm);
const STATUS_GROUPS = {
  preparing: S('PENDIENTE CONFIRMACION|PENDIENTE|GENERANDO_GUIA|GUIA_GENERADA|PREPARADO PARA TRANSPORTADORA|PICKING|PACKING|GENERADA|GENERADO|GENERADO CLIENTE CORPORATIVO|ASIGNADO|POR RECOLECTAR|EN BODEGA DROPI|RECIBIDO POR DROPI|RECOGIDO POR DROPI|EN BODEGA ORIGEN|RECOLECCION|INGRESANDO|INGRESO A CONFIRMACION|PROCESAMIENTO|NOVEDAD SOLUCIONADA|SOLUCION APROBADA'),
  transit: S('ENTREGADO A TRANSPORTADORA|EN TRANSITO|EN TRNSITO|EN RUTA|EN REPARTO|EN CAMINO|EN DISTRIBUCION A CLIENTE|EN DISTRIBUCION PARA ENTREGA EN AGENCIA|ZONA DE ENTREGA|RECOGIDO|RECOLECTADO|EMBARCANDO|TRASLADO A CENTRO LOGISTICO|INVENTARIO EN CENTRO LOGISTICO|BODEGA DESTINO|EN BODEGA|PARA RETIRO EN AGENCIA SERVIENTREGA|ENVIO LISTO EN OFICINA|RECIBIDO PUNTO DE VENTA|RECIBIDO PAU|DESTINATARIO RE-PROGRAMA FECHA DE ENTREGA|SE REALIZA VISITA A DESTINATARIO RE-PROGRAMA FECHA DE ENTREGA|EN ESPERA DE FIRMA DE DOCUMENTOS TC'),
  delivered: S('ENTREGADO|ENTREGADA GINTRACOM|REPORTADO ENTREGADO|ENTREGA DIGITALIZADA|CERTIFICACION DE PRUEBA DE ENTREGA'),
  returning: S('DEVOLUCION EN TRANSITO|EN PROCESO DE DEVOLUCION|TRANSITO A DEVOLUCION PROVEEDOR|DEVOLUCION EN RUTA|ZONA DE ENTREGA DEVOLUCION|ZONA DE ENTREGA DEVOLUCIN|NOVEDAD DEVOLUCION|DEVOLUCION DE DISTRIBUCION CLIENTE SOLICITA RETIRAR EN CS'),
  returned: S('DEVOLUCION|DEVUELTO|DEVOLUCION AL REMITENTE|CERTIFICACION DEVOLUCION AL REMITENTE|DEVOLUCION ENTREGADA A ORIGEN|DEVOLUCION EN BODEGA'),
  rejected: S('RECHAZADO'),
  cancelled: S('CANCELADO|GUIA_ANULADA|ANULADA|CANCELADA POR TRANSPORTADORA|DESAPLICADO'),
  issue: S('NOVEDAD|CON NOVEDAD|NOVEDAD EN GESTION|ERROR_GENERANDO_GUIA|FUERA DE COBERTURA, NO COINCIDE LA CIUDAD REAL DESTINO CON LA CIUDAD INGRESADA|DESTINATARIO SOLICITA CAMBIO DE DIRECCION|DESTINATARIO FALLECIDO|SINIESTRO|INCAUTADO|MERCANCIA CON AVERIA EN REPARTO. INDEMNIZACION|MERCANCIA HURTADA EN REPARTO. INDEMNIZACION|INDEMNIZACION|INDEMNIZADA POR DROPI|OBSTRUCCION EN LA VIA PUBLICA|PROBLEMAS DE ORDEN PUBLICO|ACCIDENTE EN CARRETERA|SOLUCION INCORRECTA'),
};
// "DEVOLUCIÓN / ENTREGA", "PROCESO FINALIZADO", "FINALIZADO POR RETENCION": ambiguos → unknown (revisión humana).
function mapDropiStatus(raw) {
  const s = norm(raw);
  for (const [group, list] of Object.entries(STATUS_GROUPS)) if (list.includes(s)) return group;
  return 'unknown';
}
const GROUP_STATE = { preparing: 'en_preparacion', transit: 'en_transito', delivered: 'entregado', returning: 'por_devolver', returned: 'devuelto', rejected: 'cancelado', cancelled: 'cancelado' };
const RANK = { en_preparacion: 1, enviado: 2, en_transito: 2, por_devolver: 3, entregado: 4, devuelto: 4, cancelado: 4 };
const TERMINAL = ['entregado', 'devuelto', 'cancelado'];

/**
 * Aplica un estado de Dropi a la orden con transiciones coherentes:
 * nunca retrocede; un terminal no pasa a otro terminal (→ excepción).
 * COD: entregado → pending_settlement + excepción cod_unreconciled (NO se marca
 * cobrado hasta conciliar); rechazado/devuelto/cancelado → not_collected.
 */
async function applyDropiStatus(order, info) {
  const raw = info?.status;
  if (!raw) return { changed: false };
  const group = mapDropiStatus(raw);
  const update = { deliveryStatus: String(raw).slice(0, 100) };
  // Fechas por estado (para medir el plazo real de Dropi: confirmación → entrega).
  const history = Array.isArray(order.dropiStatusHistory) ? order.dropiStatusHistory : [];
  const newGuide = Boolean(info.trackingNumber && !order.trackingNumber);
  if (history[history.length - 1]?.status !== String(raw) || newGuide) {
    update.dropiStatusHistory = [...history, { status: String(raw).slice(0, 100), group, at: (info.at ? new Date(info.at) : new Date()).toISOString(), ...(newGuide ? { guide: true } : {}) }].slice(-50);
  }
  if (newGuide) update.trackingNumber = String(info.trackingNumber).slice(0, 255);
  if (info.carrierName && !order.carrierName) update.carrierName = String(info.carrierName).slice(0, 100);
  if (info.shippingCost != null && order.shippingCost == null && Number.isFinite(Number(info.shippingCost))) update.shippingCost = Number(info.shippingCost);
  let exception = null;

  if (group === 'unknown') exception = ['unknown_status', { dropiStatus: raw }];
  else if (group === 'issue') exception = ['delivery_issue', { dropiStatus: raw }];
  else {
    const next = GROUP_STATE[group];
    const cur = order.stateOrder;
    if (TERMINAL.includes(cur) && next !== cur) exception = ['unknown_status', { dropiStatus: raw, reason: `transición incoherente ${cur} → ${next}` }];
    else if ((RANK[next] ?? 0) > (RANK[cur] ?? 0)) {
      update.stateOrder = next;
      const isCod = order.paymentMethod === 'cod';
      if (isCod && next === 'entregado') { update.codStatus = 'pending_settlement'; exception = ['cod_unreconciled', { dropiStatus: raw, expected: Number(order.total) }]; }
      if (isCod && ['devuelto', 'cancelado'].includes(next)) { update.codStatus = 'not_collected'; update.paymentStatus = 'failed'; }
    }
  }
  await order.update(update);
  if (exception) await openException(order.id, exception[0], exception[1]);
  return { changed: true, group, stateOrder: order.stateOrder, exception: exception?.[0] ?? null };
}

// ── Cancelación ──────────────────────────────────────────────────────────────
// Antes de llegar a Dropi: se detiene (CANCELLED, condicional para no pisar un
// claim concurrente). Si Dropi ya pudo recibirla: excepción para anularla allí.
// COD: una orden cancelada nunca queda como cobrada.
const PRE_SEND = ['PENDING_DISPATCH', 'PENDING_DROPI_FULFILLMENT', 'CONFIRMED', 'AWAITING_CONFIRMATION', 'BLOCKED', 'AUTOMATION_OFF', 'FAILED_DROPI_FULFILLMENT', 'TEST_NOT_SENT'];
async function onCancelled(orderId) {
  const [n] = await models.Order.update({ fulfillmentStatus: 'CANCELLED' }, {
    where: { id: orderId, dropiOrderId: null, fulfillmentStatus: { [Op.in]: PRE_SEND } },
  });
  const order = await models.Order.findByPk(orderId);
  if (order.paymentMethod === 'cod' && order.codStatus !== 'collected') {
    await order.update({ codStatus: 'not_collected', paymentStatus: 'failed' });
  }
  if (n) return { stopped: true };
  if (order.dropiOrderId || ['SENDING', 'DISPATCH_UNKNOWN', 'DISPATCHED', 'MANUAL_DISPATCH'].includes(order.fulfillmentStatus)) {
    // Dropi no tiene API de cancelación: siempre es manual.
    const fresh = await openException(orderId, 'cancelled_after_dispatch', { action: 'cancelar en el panel de Dropi', dropiOrderId: order.dropiOrderId, shopOrderId: `AYNIMAR-${orderId}`, fulfillmentStatus: order.fulfillmentStatus });
    if (fresh) await notifyAdmin(`🛑 <b>Pedido #${orderId} cancelado tras enviarse a Dropi</b>\nNo hay API de cancelación: cancelar en el panel de Dropi (AYNIMAR-${orderId}) y marcar la excepción como revisada.`);
    return { stopped: false, exception: 'cancelled_after_dispatch' };
  }
  return { stopped: false };
}

// ── Resolución de excepciones (panel) ────────────────────────────────────────
const money = (v, field) => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw boom.badRequest(`${field} inválido`);
  return Math.round(n * 100) / 100;
};

async function resolveException(id, body, adminId) {
  const { resolution, note = null, dropiOrderId, amount, shippingCost, providerFees, dropiCity } = body || {};
  const [ex] = await sel('SELECT * FROM order_exceptions WHERE id = :id', { id });
  if (!ex) throw boom.notFound('Excepción no encontrada');
  if (ex.status !== 'open') throw boom.conflict('La excepción ya está resuelta');
  if (!RESOLUTIONS[resolution]?.includes(ex.type)) throw boom.badRequest(`Resolución "${resolution}" no admitida para ${ex.type}`);
  if (resolution === 'not_created' && String(note ?? '').trim().length < 3) {
    throw boom.badRequest('not_created exige una nota: dónde se buscó AYNIMAR-<id> en el panel de Dropi (queda auditado)');
  }
  const OrderService = require('./orderService');
  const svc = new OrderService();
  const order = await svc.findOne(ex.order_id);
  if (!order) throw boom.notFound('Orden no encontrada');

  const costs = { shippingCost: money(shippingCost, 'shippingCost'), providerFees: money(providerFees, 'providerFees') };
  for (const k of Object.keys(costs)) if (costs[k] === undefined) delete costs[k];

  if (resolution === 'link') {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(dropiOrderId ?? ''))) throw boom.badRequest('dropiOrderId requerido (id del pedido en Dropi)');
    const clash = await models.Order.findOne({ where: { dropiOrderId: String(dropiOrderId), id: { [Op.ne]: order.id } } });
    if (clash) throw boom.conflict(`Ese id de Dropi ya está vinculado a la orden #${clash.id}`);
  }
  if (resolution === 'collected') {
    if (order.codStatus !== 'pending_settlement' || ['devuelto', 'cancelado'].includes(order.stateOrder)) {
      throw boom.conflict('Solo se concilia como cobrado un COD entregado y pendiente de liquidación (rechazada ≠ cobrada)');
    }
    if (money(amount, 'amount') === undefined) throw boom.badRequest('amount (importe liquidado) requerido');
  }
  if (dropiCity && ex.type === 'incomplete_address') await addCity(dropiCity);

  // Cierre atómico: si otro operador la resolvió a la vez, solo uno gana.
  const closed = await sel(`UPDATE order_exceptions SET status = 'resolved', resolution = :resolution, note = :note,
      resolved_by = :adminId, resolved_at = now(), updated_at = now()
    WHERE id = :id AND status = 'open' RETURNING id`, { id, resolution, note, adminId: adminId ?? null });
  if (!closed.length) throw boom.conflict('La excepción ya está resuelta');

  let dispatch = null;
  switch (resolution) {
    case 'link':
      await order.update({ dropiOrderId: String(dropiOrderId), fulfillmentStatus: 'DISPATCHED', fulfillmentError: null, stateOrder: 'en_preparacion', ...(order.paymentMethod === 'cod' ? { codStatus: 'pending' } : {}), dropiStatusHistory: withEvent(order, 'ENVIADO_A_DROPI', 'dispatched', { linked: true }), ...costs });
      break;
    case 'manual':
      await order.update({ fulfillmentStatus: 'MANUAL_DISPATCH', ...(dropiOrderId ? { dropiOrderId: String(dropiOrderId) } : {}), ...costs });
      break;
    case 'collected':
      await order.update({ codStatus: 'collected', paymentStatus: 'paid', codCollectedAmount: money(amount, 'amount'), ...costs });
      break;
    case 'not_collected':
      await order.update({ codStatus: 'not_collected', paymentStatus: 'failed', ...costs });
      break;
    case 'accept':
      if (NON_BLOCKING.includes(ex.type)) { if (Object.keys(costs).length) await order.update(costs); break; }
    // falls through — aceptar un bloqueo = reintentar saltándose ese tipo
    case 'retry':
    case 'not_created': {
      const open = (await openExceptionTypes(order.id)).filter((t) => BLOCKING_TYPES.includes(t));
      if (open.length) break; // aún hay otros bloqueos abiertos
      if (order.dropiOrderId) break;
      const status = resolution === 'not_created' ? 'PENDING_DROPI_FULFILLMENT' : 'PENDING_DISPATCH';
      if (resolution === 'not_created') dropi.releaseShopOrder(`AYNIMAR-${order.id}`); // una persona confirmó que no existe
      await order.update({ fulfillmentStatus: status, fulfillmentRetryCount: 0, fulfillmentError: null });
      dispatch = await svc._dispatchOrder(await svc.findOne(order.id));
      break;
    }
    default: break;
  }
  const fresh = await models.Order.findByPk(order.id);
  return {
    id: Number(id), orderId: order.id, type: ex.type, resolution,
    order: { fulfillmentStatus: fresh.fulfillmentStatus, stateOrder: fresh.stateOrder, dropiOrderId: fresh.dropiOrderId, codStatus: fresh.codStatus, paymentStatus: fresh.paymentStatus },
    dispatch,
  };
}

module.exports = {
  getConfig,
  preDispatch,
  validateOrder,
  buildDropiLines,
  normalizePhoneEC,
  openException,
  listExceptions,
  resolveException,
  blockingCatalogIssues,
  hasBlockingIssue,
  customerNotice,
  sourcingInfo,
  mapDropiStatus,
  applyDropiStatus,
  handleTelegramCallback,
  onCancelled,
  isTestOrder,
  ownerOrderAlertText,
  notifyOwnerNewOrder,
  PANEL_URL,
  escHtml,
  realDispatchedCount,
  realDispatchedToday,
  ecuadorDayStart,
  buildShipping,
  EXCEPTION_TYPES,
  BLOCKING_TYPES,
  RESOLUTIONS,
};
