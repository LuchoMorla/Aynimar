'use strict';

/**
 * Proveedores alternativos: puntúa candidatos de Dropi frente a un producto de la
 * tienda, los clasifica (EXACTO / SIMILAR / DISTINTO) y guarda estado y auditoría
 * en supplier_candidates. NUNCA llama a Dropi, NUNCA toca el producto ni pedidos:
 * `preparado_preferente` es una propuesta lista; aplicarla sigue siendo la decisión
 * swap_dropi_id de Salud del catálogo, y un artículo distinto exige la aceptación
 * del cliente.
 *
 * Motor (puro, determinista y explicable):
 *   - texto: tokens normalizados en español + atributos clave (tipo, medidas,
 *     «N en M», modelo, marca, cantidad, accesorios);
 *   - imagen: distancia de Hamming entre hashes perceptuales (dHash 64 bits)
 *     calculados FUERA del backend (no hay librería de imagen instalada). Sin hash
 *     → «sin_comparar»;
 *   - precio/coste/stock: coste total (coste + flete) y contribución con rechazo
 *     COD del 15 % y del 30 % (financeContribution).
 * Datos que no vienen de Dropi (verificado, premium, nombre del proveedor) quedan
 * null = «sin datos»: nunca se inventan.
 * Ver docs/SUPPLIER_CANDIDATES.md.
 */

const boom = require('@hapi/boom');
const Joi = require('joi');
const { QueryTypes } = require('sequelize');

const sequelize = require('../libs/sequelize');
const { contributionPerOrder, minProfitablePrice } = require('./financeContribution');

const STATUSES = ['propuesto', 'preparado_preferente', 'descartado', 'aprobado_por_propietario'];
const TRANSITIONS = {
  propuesto: ['descartado', 'preparado_preferente', 'aprobado_por_propietario'],
  preparado_preferente: ['propuesto', 'descartado', 'aprobado_por_propietario'],
  descartado: ['propuesto'],
  aprobado_por_propietario: ['propuesto', 'descartado'],
};
const CLASS_RANK = { EXACTO: 0, SIMILAR: 1, DISTINTO: 2 };

// Supuestos del margen (los mismos que margenes.md y el scan de Salud del catálogo).
const COMMISSION = 0.03;
const FREIGHT_ASSUMED = [5.10, 7.96];
const REJECT_RATES = [0.15, 0.30];
const STOCK_FRESH_H = 72;     // un stock más viejo no cuenta como disponibilidad confirmada
const LOW_STOCK = 5;
// Umbrales de imagen (Hamming sobre 64 bits). ponytail: fijos; calibrar con pares reales.
const IMG_NEAR = 6;
const IMG_SIMILAR = 14;
const TEXT_MIN = 0.3;          // Jaccard por debajo → DISTINTO

// ── Texto ────────────────────────────────────────────────────────────────────
const STOP = new Set('de del la las el los lo para con sin y e en a al por un una unos unas su sus tu tus que o u mas muy tipo nuevo nueva original modelo'.split(' '));
const GENERIC = new Set(['kit', 'set', 'combo', 'juego', 'pack', 'mini', 'super', 'pro', 'max', 'plus', 'modelo']);
// Sinónimos (se aplican tras quitar plurales). Se listan en la evidencia cuando actúan.
const SYN = { comedor: 'comedero', comida: 'comedero', mascotas: 'mascota', audifono: 'audifono', auricular: 'audifono', lente: 'gafa', anteojo: 'gafa', parlante: 'parlante', altavoz: 'parlante', bocina: 'parlante' };
const UNITS = { kg: 'kg', kilo: 'kg', kilos: 'kg', g: 'g', gr: 'g', grs: 'g', ml: 'ml', l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l', cm: 'cm', mm: 'mm', m: 'm', mt: 'm', mts: 'm', metro: 'm', metros: 'm', w: 'w', watt: 'w', watts: 'w', mah: 'mah', v: 'v', pulgadas: 'in', pulg: 'in' };
const ACCESSORIES = new Set(['comedero', 'cargador', 'control', 'estuche', 'funda', 'soporte', 'bolsa', 'base', 'cable', 'filtro', 'adaptador', 'bomba', 'tapa', 'correa', 'mando', 'bateria', 'panel', 'guante', 'microfono', 'bluetooth']);
// ponytail: lista corta de marcas vistas en el catálogo; el campo `brand` del export manda si viene.
const BRANDS = new Set(['venum', 'everlast', 'marvo', 'alexa', 'echo', 'amazon', 'xiaomi', 'samsung', 'apple', 'jbl', 'sony', 'philips', 'oster', 'dior', 'sauvage', 'tp-link', 'lenovo', 'havit', 'redmi']);

const deaccent = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function singular(t) {
  if (t.length <= 4 || /\d/.test(t)) return t;
  if (/[lrnd]es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s')) return t.slice(0, -1);
  return t;
}

/** Texto → tokens normalizados (sin tildes, plurales ni palabras vacías). */
function tokenize(text) {
  let s = deaccent(text)
    .replace(/(\d)\s*en\s*(\d)/g, '$1en$2')                            // «2 en 1», «2 en1» → 2en1
    .replace(/\b([a-z]{1,4})[-\s](\d{1,5})\b/g, (m, a, d) => (UNITS[a] ? m : `${a}${d}`)) // F-01 → f01, V 13 → v13
    .replace(/(\d+(?:[.,]\d+)?)\s*(kg|kilos?|grs?|g|ml|lts?|litros?|l|cm|mm|mts?|metros?|m|watts?|w|mah|v|pulgadas|pulg)\b/g,
      (m, n, u) => `${n.replace(',', '.')}${UNITS[u]}`)
    .replace(/\bx\s*(\d{1,3})\b/g, 'x$1');
  s = s.replace(/[^a-z0-9.]+/g, ' ');
  return s.split(' ').map((t) => t.replace(/^\.+|\.+$/g, '')).filter((t) => t && !STOP.has(t))
    .map((t) => SYN[singular(t)] || singular(t));
}

/** Atributos clave desde tokens (+ marca explícita si existe). */
function extractAttributes(tokens, brand) {
  const units = tokens.filter((t) => /^\d+(\.\d+)?(kg|g|ml|l|cm|mm|m|w|mah|v|in)$/.test(t));
  const combos = tokens.filter((t) => /^\d+en\d+$/.test(t));
  const qty = tokens.filter((t) => /^x\d+$/.test(t));
  const models = tokens.filter((t) => /[a-z]/.test(t) && /\d/.test(t) && !units.includes(t) && !combos.includes(t) && !qty.includes(t));
  const brands = brand ? [deaccent(brand).trim()] : tokens.filter((t) => BRANDS.has(t));
  const type = tokens.find((t) => !/\d/.test(t) && !GENERIC.has(t) && !BRANDS.has(t)) || null;
  const accessories = tokens.filter((t) => ACCESSORIES.has(t));
  return { type, units, combos, models, brands, qty, accessories };
}

const unitOf = (u) => u.replace(/^[\d.]+/, '');

/**
 * Compara textos. Explica cada diferencia:
 *   conflicts = el candidato dice OTRA cosa (otra medida, otro modelo, otra marca, otro «N en M»);
 *   missing   = el candidato no menciona un atributo clave de la tienda (no verificable).
 */
function compareText(storeName, candName, { storeBrand, candBrand } = {}) {
  const a = tokenize(storeName);
  const b = tokenize(candName);
  const A = new Set(a);
  const B = new Set(b);
  const shared = [...A].filter((t) => B.has(t));
  const union = new Set([...A, ...B]);
  const jaccard = union.size ? Math.round((shared.length / union.size) * 1000) / 1000 : 0;
  const sa = extractAttributes(a, storeBrand);
  const sb = extractAttributes(b, candBrand);
  const conflicts = [];
  const missing = [];

  if (sa.type && !B.has(sa.type)) missing.push(`tipo «${sa.type}»`);
  for (const u of sa.units) {
    if (sb.units.includes(u)) continue;
    const other = sb.units.filter((x) => unitOf(x) === unitOf(u));
    if (other.length) conflicts.push(`medida ${u} ≠ ${other.join('/')}`); else missing.push(`medida ${u}`);
  }
  for (const c of sa.combos) {
    if (sb.combos.includes(c)) continue;
    if (sb.combos.length) conflicts.push(`${c} ≠ ${sb.combos.join('/')}`); else missing.push(`«${c.replace('en', ' en ')}»`);
  }
  for (const m of sa.models) if (!sb.models.includes(m)) (sb.models.length ? conflicts : missing).push(`modelo ${m}${sb.models.length ? ` ≠ ${sb.models.join('/')}` : ''}`);
  for (const br of sa.brands) if (!sb.brands.includes(br)) (sb.brands.length ? conflicts : missing).push(`marca ${br}${sb.brands.length ? ` ≠ ${sb.brands.join('/')}` : ''}`);
  for (const q of sa.qty) if (!sb.qty.includes(q)) (sb.qty.length ? conflicts : missing).push(`cantidad ${q}${sb.qty.length ? ` ≠ ${sb.qty.join('/')}` : ''}`);
  for (const acc of sa.accessories) if (!B.has(acc) && acc !== sa.type) missing.push(`accesorio «${acc}»`);
  for (const c of sb.combos) if (!sa.combos.length) conflicts.push(`el candidato es ${c} y la tienda no`);

  const synonyms = [...new Set(deaccent(`${storeName} ${candName}`).split(/[^a-z]+/).map(singular).filter((t) => SYN[t] && SYN[t] !== t).map((t) => `${t}→${SYN[t]}`))];
  return {
    score: jaccard, shared, onlyStore: [...A].filter((t) => !B.has(t)), onlyCandidate: [...B].filter((t) => !A.has(t)),
    storeAttributes: sa, candidateAttributes: sb, conflicts, missing, synonyms,
    sameBrandAndModel: sa.brands.length > 0 && sa.models.length > 0 && conflicts.length === 0
      && sa.brands.every((x) => sb.brands.includes(x)) && sa.models.every((x) => sb.models.includes(x)),
  };
}

// ── Imagen ───────────────────────────────────────────────────────────────────
const HASH_RE = /^[0-9a-f]{16}$/i;
function compareImage(storeHash, candHash) {
  if (!HASH_RE.test(storeHash || '') || !HASH_RE.test(candHash || '')) {
    return { status: 'sin_comparar', distance: null, reason: !HASH_RE.test(storeHash || '') ? 'falta el hash de la imagen de la tienda' : 'falta el hash de la imagen del candidato' };
  }
  let d = 0; // Hamming por nibbles hex (sin BigInt: el eslint del repo no lo admite)
  for (let i = 0; i < 16; i++) {
    let x = parseInt(storeHash[i], 16) ^ parseInt(candHash[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return { status: d <= IMG_NEAR ? 'casi_identica' : d <= IMG_SIMILAR ? 'parecida' : 'distinta', distance: d, method: 'dHash 64 bits (Hamming)' };
}

// ── Precio, coste, stock ─────────────────────────────────────────────────────
const round2 = (n) => Math.round(n * 100) / 100;

/** Contribución esperada por pedido con rechazo 15 % y 30 %. Sin flete → rango supuesto. */
function marginFor(pvp, cost, freight) {
  if (!(pvp > 0) || !(cost >= 0) || cost === null) return { incomplete: true, reason: !(pvp > 0) ? 'sin PVP' : 'sin coste' };
  const known = typeof freight === 'number' && freight >= 0;
  const base = {
    pvp, cost, costIncludesVat: false, commissionRate: COMMISSION, deliveryRate: null,
    shipping: known ? freight : null, returnCost: known ? freight : null,
    assumptions: known ? undefined : { shipping: FREIGHT_ASSUMED, returnCost: FREIGHT_ASSUMED },
  };
  const out = { pvp, cost, freight: known ? freight : FREIGHT_ASSUMED, commissionRate: COMMISSION, returnCost: 'igual al flete de ida' };
  for (const r of REJECT_RATES) {
    const res = contributionPerOrder({ ...base, returnRate: r });
    const be = minProfitablePrice({ ...base, returnRate: r, targetMargin: 0 });
    out[`r${r * 100}`] = { contribution: res.contribution, contributionBest: res.best?.contribution ?? null, marginOnNet: res.marginOnNet, breakEvenPvp: be.valid ? be.minPvp : null };
  }
  return out;
}

function stockStatus(stock, checkedAt, now = Date.now()) {
  if (stock === null || stock === undefined) return { status: 'sin_datos', stock: null, checkedAt: checkedAt || null };
  const age = checkedAt ? (now - new Date(checkedAt).getTime()) / 3600e3 : null;
  const fresh = age !== null && age >= 0 && age <= STOCK_FRESH_H;
  const status = stock <= 0 ? 'agotado' : !fresh ? 'sin_confirmar' : stock <= LOW_STOCK ? 'bajo' : 'confirmado';
  return { status, stock, checkedAt: checkedAt || null, ageHours: age === null ? null : Math.round(age), freshLimitHours: STOCK_FRESH_H };
}

/**
 * Puntúa un candidato frente al producto. PURA.
 * @param {{name, price, costPrice, brand?, imageHash?}} product  tienda
 * @param {{name, cost, stock, stockCheckedAt, freight, freightSource, brand?, imageHash?, supplierVerified, supplierPremium}} cand
 * @param {{currentFreight?: number|null}} [ctx]  flete del proveedor actual, para el coste de referencia
 */
function scoreCandidate(product, cand, ctx = {}, now = Date.now()) {
  const text = compareText(product.name, cand.name, { storeBrand: product.brand, candBrand: cand.brand });
  const image = compareImage(product.imageHash, cand.imageHash);
  const stock = stockStatus(cand.stock, cand.stockCheckedAt, now);
  const freightKnown = typeof cand.freight === 'number';
  const freightUsed = freightKnown ? cand.freight : FREIGHT_ASSUMED[1];
  const totalCost = cand.cost === null || cand.cost === undefined ? null : round2(cand.cost + freightUsed);
  const refFreight = typeof ctx.currentFreight === 'number' ? ctx.currentFreight : freightUsed;
  const baselineTotal = product.costPrice > 0 ? round2(Number(product.costPrice) + refFreight) : null;
  const margin = marginFor(Number(product.price), cand.cost === null || cand.cost === undefined ? null : Number(cand.cost), freightKnown ? cand.freight : null);

  let classification = 'SIMILAR';
  const why = [];
  if (text.conflicts.length) { classification = 'DISTINTO'; why.push(`atributos en conflicto: ${text.conflicts.join('; ')}`); }
  if (text.missing.length >= 2) { classification = 'DISTINTO'; why.push(`faltan ${text.missing.length} atributos clave: ${text.missing.join('; ')}`); }
  if (text.score < TEXT_MIN) { classification = 'DISTINTO'; why.push(`texto poco parecido (Jaccard ${text.score} < ${TEXT_MIN})`); }
  if (image.status === 'distinta') { classification = 'DISTINTO'; why.push(`imagen distinta (Hamming ${image.distance})`); }
  if (text.missing.length === 1) why.push(`atributo no verificable: ${text.missing[0]}`);
  if (classification !== 'DISTINTO') {
    const attrsOk = text.missing.length === 0;
    if (attrsOk && image.status === 'casi_identica') { classification = 'EXACTO'; why.push(`atributos clave coinciden e imagen casi idéntica (Hamming ${image.distance})`); }
    else if (attrsOk && image.status === 'sin_comparar' && text.sameBrandAndModel) { classification = 'EXACTO'; why.push('atributos clave coinciden; sin imagen, pero marca y modelo idénticos'); }
    else {
      if (image.status === 'sin_comparar') why.push(`imagen sin comparar (${image.reason})${text.sameBrandAndModel ? '' : ' y sin marca+modelo idénticos'}`);
      if (image.status === 'parecida') why.push(`imagen solo parecida (Hamming ${image.distance})`);
    }
  }

  return {
    classification,
    scores: {
      text: { score: text.score, shared: text.shared, onlyStore: text.onlyStore, onlyCandidate: text.onlyCandidate, synonyms: text.synonyms },
      image,
      price: { cost: cand.cost ?? null, suggestedPrice: cand.suggestedPrice ?? null, pvp: Number(product.price) || null, totalCost, baselineTotal, baselineFreight: refFreight,
        delta: totalCost !== null && baselineTotal !== null ? round2(totalCost - baselineTotal) : null },
      stock,
    },
    attributes: { store: text.storeAttributes, candidate: text.candidateAttributes },
    margin,
    evidence: { reasons: why, conflicts: text.conflicts, missing: text.missing, freightSource: freightKnown ? cand.freightSource || 'sin fuente' : `ESTIMADO (rango ${FREIGHT_ASSUMED.join('–')}; coste total con ${FREIGHT_ASSUMED[1]})` },
  };
}

/** Reglas del propietario para `preparado_preferente`. Devuelve cada comprobación con su motivo. */
function preferredChecks(row) {
  const s = row.scores || {};
  const checks = [
    { check: 'articulo_identico', ok: row.classification === 'EXACTO', detail: `clasificación ${row.classification}` },
    { check: 'proveedor_confiable', ok: row.supplierVerified === true || row.supplierPremium === true,
      detail: row.supplierVerified === null && row.supplierPremium === null ? 'sin datos de verificación/premium desde Dropi' : `verificado=${row.supplierVerified}, premium=${row.supplierPremium}` },
    { check: 'disponibilidad_confirmada', ok: ['confirmado', 'bajo'].includes(s.stock?.status), detail: `stock ${s.stock?.stock ?? 'sin datos'} (${s.stock?.status ?? 'sin_datos'})` },
    { check: 'coste_total_igual_o_menor', ok: s.price?.delta !== null && s.price?.delta !== undefined && s.price.delta <= 0,
      detail: s.price?.baselineTotal === null || s.price?.baselineTotal === undefined ? 'sin coste de referencia del proveedor actual' : `total ${s.price.totalCost} vs actual ${s.price.baselineTotal}` },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/** Orden dentro de un producto: clasificación, contribución r=30 %, stock. Determinista. */
function rank(a, b) {
  return CLASS_RANK[a.classification] - CLASS_RANK[b.classification]
    || (b.margin?.r30?.contribution ?? -1e9) - (a.margin?.r30?.contribution ?? -1e9)
    || (b.stock ?? -1) - (a.stock ?? -1)
    || String(a.dropiProductId).localeCompare(String(b.dropiProductId));
}

// ── Entrada: export de Dropi (list_products) y CSV de equivalencias ──────────
const CDN = 'https://d39ru7awumhhs2.cloudfront.net/';
const numOrNull = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const boolOrNull = (v) => (v === true ? true : v === false ? false : null);

/** Un producto crudo de list_products → candidatos (uno por variante si las hay). */
function fromDropi(raw, { stockCheckedAt = null } = {}) {
  const g = Array.isArray(raw.gallery) ? raw.gallery[0] : null;
  const path = g?.urlS3 || g?.url || raw.image || null;
  // ponytail: gallery.urlS3 relativo → CDN de Dropi Ecuador (el que usan las fotos de equivalencias).
  const imageUrl = path ? (/^https?:\/\//.test(path) ? path : `${CDN}${String(path).replace(/^\/+/, '')}`) : null;
  const sup = raw.supplier && typeof raw.supplier === 'object' ? raw.supplier : {};
  const base = {
    dropiProductId: String(raw.id), dropiVariationId: null, name: raw.name ?? null, brand: raw.brand ?? null,
    cost: numOrNull(raw.sale_price ?? raw.cost), suggestedPrice: numOrNull(raw.suggested_price), stock: numOrNull(raw.stock),
    stockCheckedAt: raw.stockCheckedAt || stockCheckedAt, supplierId: raw.supplier_id != null ? String(raw.supplier_id) : (sup.id != null ? String(sup.id) : null),
    supplierName: sup.name ?? null, supplierVerified: boolOrNull(sup.verified), supplierPremium: boolOrNull(sup.premium),
    imageUrl, imageHash: raw.imageHash ?? null, freight: numOrNull(raw.freight), freightSource: raw.freightSource ?? null,
    categories: Array.isArray(raw.categories) ? raw.categories.map((c) => c?.name ?? c).filter(Boolean) : [],
    sourceNote: raw.evidence ?? null,
  };
  const vars = Array.isArray(raw.variations) ? raw.variations : [];
  if (!vars.length) return [base];
  return vars.map((v) => {
    const attrs = (Array.isArray(v.attributes) ? v.attributes : []).map((x) => x?.value).filter(Boolean);
    return { ...base, dropiVariationId: String(v.id), name: [raw.name, ...attrs].join(' '), cost: numOrNull(v.sale_price) ?? base.cost, stock: numOrNull(v.stock), variationAttributes: attrs };
  });
}

/** Fila de informes/equivalencias-dropi.csv → candidato. */
function fromEquivalenceRow(r, { stockCheckedAt = null } = {}) {
  const sid = String(r.proveedor || '').match(/\d+/);
  return {
    dropiProductId: String(r.candidato_id), dropiVariationId: null, name: r.candidato_nombre || null, brand: null,
    cost: numOrNull(r.coste), suggestedPrice: null, stock: numOrNull(r.stock), stockCheckedAt,
    supplierId: sid ? sid[0] : null, supplierName: null, supplierVerified: null, supplierPremium: null,
    imageUrl: r.foto_url || null, imageHash: null, freight: null, freightSource: null, categories: [],
    sourceNote: [r.confianza ? `confianza previa (manual): ${r.confianza}` : null, r.evidencia || null].filter(Boolean).join(' · ') || null,
  };
}

// ── Persistencia ─────────────────────────────────────────────────────────────
const sel = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const COLS = `id, product_id AS "productId", dropi_product_id AS "dropiProductId", dropi_variation_id AS "dropiVariationId", name,
  supplier_id AS "supplierId", supplier_name AS "supplierName", supplier_verified AS "supplierVerified", supplier_premium AS "supplierPremium",
  cost::float AS cost, stock, stock_checked_at AS "stockCheckedAt", freight::float AS freight, freight_source AS "freightSource",
  image_url AS "imageUrl", image_hash AS "imageHash", attributes, scores, margin, classification, evidence, status, source, history,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

// jsonb no conserva el orden de las claves: comparar en forma canónica.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

const entry = (by, from, to, note, extra = {}) => ({ at: new Date().toISOString(), by: by ?? null, from, to, note: note || null, ...extra });

const refreshSchema = Joi.object({
  source: Joi.string().valid('equivalencias_csv', 'dropi_export').required(),
  products: Joi.array().min(1).max(500).items(Joi.object({
    productId: Joi.number().integer().positive().required(),
    storeImageHash: Joi.string().pattern(HASH_RE).allow(null, ''),
    storeBrand: Joi.string().max(100).allow(null, ''),
    currentFreight: Joi.number().min(0).allow(null),
    candidates: Joi.array().max(50).items(Joi.object({
      dropiProductId: Joi.string().pattern(/^\d{1,12}$/).required(),
      dropiVariationId: Joi.string().pattern(/^\d{1,12}$/).allow(null),
      name: Joi.string().max(300).allow(null, ''),
      cost: Joi.number().min(0).allow(null), stock: Joi.number().integer().allow(null),
      stockCheckedAt: Joi.date().iso().allow(null),
      freight: Joi.number().min(0).allow(null), freightSource: Joi.string().max(120).allow(null, ''),
      imageUrl: Joi.string().max(1000).pattern(/^https?:\/\/\S+$/).allow(null, ''),
      imageHash: Joi.string().pattern(HASH_RE).allow(null, ''),
      supplierVerified: Joi.boolean().allow(null), supplierPremium: Joi.boolean().allow(null),
    }).unknown(true)).required(),
  })).required(),
});

/**
 * Upsert de candidatos y re-evaluación. Idempotente por (producto, id, variante).
 * Conserva el estado; si un preparado_preferente deja de cumplir las reglas, vuelve a
 * `propuesto` con entrada de auditoría (vigilancia). Nada toca products ni orders.
 */
async function refresh(body, { now = Date.now(), by = 'refresh' } = {}) {
  const input = Joi.attempt(body, refreshSchema, { abortEarly: false, allowUnknown: true });
  const ids = input.products.map((p) => p.productId);
  const products = await sel('SELECT id, name, price::float AS price, cost_price::float AS "costPrice" FROM products WHERE id IN (:ids)', { ids });
  const byId = new Map(products.map((p) => [p.id, p]));
  const res = { created: 0, updated: 0, unchanged: 0, demoted: 0, skipped: [] };

  await sequelize.transaction(async (t) => {
    for (const item of input.products) {
      const p = byId.get(item.productId);
      if (!p) { res.skipped.push({ productId: item.productId, reason: 'el producto no existe' }); continue; }
      const product = { ...p, brand: item.storeBrand || null, imageHash: item.storeImageHash || null };
      for (const c of item.candidates) {
        const s = scoreCandidate(product, c, { currentFreight: item.currentFreight ?? null }, now);
        const data = {
          productId: p.id, dropiProductId: c.dropiProductId, dropiVariationId: c.dropiVariationId || null, name: c.name || null,
          supplierId: c.supplierId ?? null, supplierName: c.supplierName ?? null,
          supplierVerified: c.supplierVerified ?? null, supplierPremium: c.supplierPremium ?? null,
          cost: c.cost ?? null, stock: c.stock ?? null, stockCheckedAt: c.stockCheckedAt ? new Date(c.stockCheckedAt).toISOString() : null,
          freight: c.freight ?? null, freightSource: c.freightSource || null, imageUrl: c.imageUrl || null, imageHash: c.imageHash || null,
          attributes: JSON.stringify({ ...s.attributes, categories: c.categories || [], variation: c.variationAttributes || null }),
          scores: JSON.stringify(s.scores), margin: JSON.stringify(s.margin), classification: s.classification,
          evidence: JSON.stringify({ ...s.evidence, imageUrl: c.imageUrl || null, sourceNote: c.sourceNote || null, source: input.source }),
          source: input.source,
        };
        const ins = await sel(`
          INSERT INTO supplier_candidates (product_id, dropi_product_id, dropi_variation_id, name, supplier_id, supplier_name, supplier_verified,
            supplier_premium, cost, stock, stock_checked_at, freight, freight_source, image_url, image_hash, attributes, scores, margin,
            classification, evidence, status, source, history)
          VALUES (:productId, :dropiProductId, :dropiVariationId, :name, :supplierId, :supplierName, :supplierVerified, :supplierPremium,
            :cost, :stock, :stockCheckedAt, :freight, :freightSource, :imageUrl, :imageHash, CAST(:attributes AS jsonb), CAST(:scores AS jsonb),
            CAST(:margin AS jsonb), :classification, CAST(:evidence AS jsonb), 'propuesto', :source, CAST(:history AS jsonb))
          ON CONFLICT DO NOTHING RETURNING id`, { ...data, history: JSON.stringify([entry(by, null, 'propuesto', `alta desde ${input.source}`)]) }, t);
        if (ins.length) { res.created++; continue; }

        const [row] = await sel(`SELECT id, status, scores, margin, classification, evidence, cost::float AS cost, stock, history FROM supplier_candidates
           WHERE product_id = :productId AND dropi_product_id = :dropiProductId AND COALESCE(dropi_variation_id, '') = COALESCE(:dropiVariationId, '')
           FOR UPDATE`, data, t);
        const same = row.classification === data.classification && row.cost === data.cost && row.stock === data.stock
          && canon(row.scores) === canon(s.scores) && canon(row.margin) === canon(s.margin);
        let status = row.status;
        const history = row.history || [];
        if (status === 'preparado_preferente') {
          const chk = preferredChecks({ ...data, scores: s.scores });
          if (!chk.ok) {
            status = 'propuesto';
            history.push(entry(by, 'preparado_preferente', 'propuesto', 'deja de cumplir las reglas del preferente', { checks: chk.checks.filter((x) => !x.ok) }));
            res.demoted++;
          }
        }
        if (same && status === row.status) { res.unchanged++; continue; }
        await sel(`UPDATE supplier_candidates SET name = :name, supplier_id = :supplierId, supplier_name = :supplierName,
            supplier_verified = :supplierVerified, supplier_premium = :supplierPremium, cost = :cost, stock = :stock,
            stock_checked_at = :stockCheckedAt, freight = :freight, freight_source = :freightSource, image_url = :imageUrl,
            image_hash = :imageHash, attributes = CAST(:attributes AS jsonb), scores = CAST(:scores AS jsonb), margin = CAST(:margin AS jsonb),
            classification = :classification, evidence = CAST(:evidence AS jsonb), source = :source, status = :status,
            history = CAST(:history AS jsonb), updated_at = now()
          WHERE id = :id RETURNING id`, { ...data, id: row.id, status, history: JSON.stringify(history) }, t);
        res.updated++;
      }
    }
  });
  return res;
}

function serialize(r) {
  // La frescura del stock se evalúa al leer: un dato de hace 4 días ya no está «confirmado».
  const scores = { ...r.scores, stock: stockStatus(r.stock, r.stockCheckedAt) };
  return { ...r, scores, preferredChecks: preferredChecks({ ...r, scores }), requiresCustomerAcceptance: r.classification !== 'EXACTO' };
}

/** Candidatos agrupados por producto, ordenados (mejor primero). */
async function list({ productId, status } = {}) {
  const where = [];
  if (productId) where.push('c.product_id = :productId');
  if (status && status !== 'all') where.push('c.status = :status');
  const rows = await sel(`SELECT ${COLS} FROM supplier_candidates c
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, { productId, status });
  const pids = [...new Set(rows.map((r) => r.productId))];
  const prods = pids.length ? await sel(`SELECT id, name, price::float AS price, cost_price::float AS "costPrice", dropi_product_id AS "dropiProductId"
     FROM products WHERE id IN (:pids)`, { pids }) : [];
  const byId = new Map(prods.map((p) => [p.id, p]));
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.productId)) {
      const p = byId.get(r.productId) || {};
      groups.set(r.productId, { productId: r.productId, productName: p.name ?? null, productPrice: p.price ?? null, costPrice: p.costPrice ?? null, dropiProductId: p.dropiProductId ?? null, candidates: [] });
    }
    groups.get(r.productId).candidates.push(serialize(r));
  }
  const products = [...groups.values()].sort((a, b) => a.productId - b.productId);
  for (const g of products) {
    g.candidates.sort(rank);
    g.preferred = g.candidates.find((c) => c.status === 'preparado_preferente')?.id ?? null;
  }
  return { generatedAt: new Date().toISOString(), products };
}

const statusSchema = Joi.object({
  status: Joi.string().valid(...STATUSES).required(),
  note: Joi.string().allow('').max(1000),
});

/**
 * Cambia el estado de un candidato (solo admin). Reglas:
 *   - preparado_preferente: SOLO si cumple preferredChecks (idéntico, proveedor confiable con
 *     dato de Dropi, stock confirmado, coste total ≤ actual); si no → 422 con las comprobaciones.
 *     Uno por producto (409 si ya hay otro).
 *   - aprobado_por_propietario: exige nota; queda registrado si requiere aceptación del cliente.
 * Nunca toca el producto ni pedidos.
 */
async function setStatus(id, body, userId) {
  const { status, note } = Joi.attempt(body, statusSchema, { abortEarly: false });
  const by = Number.isInteger(Number(userId)) ? Number(userId) : null;
  await sequelize.transaction(async (t) => {
    const [row] = await sel(`SELECT ${COLS} FROM supplier_candidates WHERE id = :id FOR UPDATE`, { id }, t);
    if (!row) throw boom.notFound('candidato no encontrado');
    if (!TRANSITIONS[row.status].includes(status)) throw boom.conflict(`transición no permitida: ${row.status} → ${status}`);
    const extra = {};
    if (status === 'preparado_preferente') {
      // Re-evalúa con el coste actual del producto y la antigüedad actual del stock (pudieron cambiar desde el refresh).
      const [p] = await sel('SELECT cost_price::float AS "costPrice" FROM products WHERE id = :pid', { pid: row.productId }, t);
      if (!p) throw boom.notFound('producto no encontrado');
      const price = { ...row.scores.price };
      price.baselineTotal = p.costPrice > 0 ? round2(p.costPrice + (price.baselineFreight ?? FREIGHT_ASSUMED[1])) : null;
      price.delta = price.totalCost != null && price.baselineTotal != null ? round2(price.totalCost - price.baselineTotal) : null;
      const chk = preferredChecks({ ...row, scores: { ...row.scores, price, stock: stockStatus(row.stock, row.stockCheckedAt) } });
      extra.checks = chk.checks;
      if (!chk.ok) {
        const e = boom.badData('no cumple las reglas del proveedor alternativo preferente');
        e.output.payload.checks = chk.checks; // el panel muestra qué falla
        throw e;
      }
      const [other] = await sel("SELECT id FROM supplier_candidates WHERE product_id = :pid AND status = 'preparado_preferente' AND id <> :id", { pid: row.productId, id }, t);
      if (other) throw boom.conflict(`el producto ya tiene un preferente (candidato ${other.id})`);
    }
    if (status === 'aprobado_por_propietario') {
      if (String(note ?? '').trim().length < 3) throw boom.badRequest('aprobado_por_propietario exige una nota');
      extra.requiresCustomerAcceptance = row.classification !== 'EXACTO';
    }
    const history = [...(row.history || []), entry(by, row.status, status, note, extra)];
    await sel('UPDATE supplier_candidates SET status = :status, history = CAST(:history AS jsonb), updated_at = now() WHERE id = :id RETURNING id',
      { id, status, history: JSON.stringify(history) }, t).catch((err) => {
      // Carrera entre dos «preparar» del mismo producto: gana uno (índice único parcial).
      if ((err.parent || err.original)?.code === '23505') throw boom.conflict('el producto ya tiene un preferente');
      throw err;
    });
  });
  const [fresh] = await sel(`SELECT ${COLS} FROM supplier_candidates WHERE id = :id`, { id });
  return serialize(fresh);
}

/** Para pedidos: candidatos vivos de un producto (sin descartados), ya ordenados. */
async function liveCandidates(productId) {
  const rows = await sel(`SELECT ${COLS} FROM supplier_candidates WHERE product_id = :productId AND status <> 'descartado'`, { productId });
  return rows.sort(rank);
}

module.exports = {
  STATUSES, TRANSITIONS, refreshSchema, statusSchema,
  tokenize, extractAttributes, compareText, compareImage, marginFor, stockStatus, scoreCandidate, preferredChecks, rank,
  fromDropi, fromEquivalenceRow, refresh, list, setStatus, liveCandidates,
};
