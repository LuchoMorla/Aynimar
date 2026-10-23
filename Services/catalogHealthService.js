'use strict';

/**
 * Salud del catálogo: detecta productos problemáticos y propone acciones; el
 * propietario decide en el panel y la decisión queda registrada en catalog_issues.
 *
 * Dos fuentes de issues:
 *   - scan   → reglas sobre la BD (productos visibles en tienda): precio/coste,
 *              stock, categoría, textos. Margen con financeContribution y supuestos
 *              de flete explícitos (SCAN_ASSUMPTIONS).
 *   - import → filas del análisis offline de márgenes (margenes.csv): existencia en
 *              Dropi, coste y flete reales, contribución r=15%/30%.
 * Upsert idempotente por (product_id, type) mientras está 'open' (índice único
 * parcial). Un issue cerrado por decisión (decided/dismissed) no se reabre
 * mientras el problema sea el mismo (misma `fingerprint`).
 * Ver docs/CATALOG_HEALTH.md.
 */

const boom = require('@hapi/boom');
const Joi = require('joi');
const { QueryTypes } = require('sequelize');

const sequelize = require('../libs/sequelize');
const { contributionPerOrder, minProfitablePrice } = require('./financeContribution');

const { models } = sequelize;

const TYPES = [
  'dropi_not_found', 'dropi_out_of_stock', 'low_stock', 'negative_margin', 'thin_margin',
  'missing_cost', 'missing_freight', 'risky_category', 'unverified_claims', 'missing_dropi_id',
];
const ACTIONS = ['swap_dropi_id', 'hide', 'set_price', 'bundle_only', 'keep', 'dismiss'];
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const LOW_STOCK = 5;          // stock 1..5 → low_stock
const THIN_MARGIN = 0.10;     // margen sobre neto < 10% en el peor supuesto → thin_margin
const THIN_CONTRIB_USD = 1;   // import: contribución r=30% < 1 USD → thin_margin
// ponytail: supuestos fijos para el scan (min real 5.10 – voluminoso 7.96, vuelta = ida,
// rechazo 15–30%, comisión de recaudo 3%). Un producto pesado queda corto: el import con
// flete REAL lo sustituye. Subir a config por producto si hace falta.
const SCAN_ASSUMPTIONS = { shipping: [5.10, 7.96], returnCost: [5.10, 7.96], returnRate: [0.15, 0.30] };
const SCAN_COMMISSION = 0.03;

const RISKY_RE = /vap(e|eo|eador|orizador)|cigarr|sex\s*shop|er[oó]tic|consolador|vibrador|juego\s+para\s+adult/i;
const CLAIMS = [
  { re: /solo\s+quedan/i, label: 'escasez: «solo quedan»' },
  { re: /[uú]ltimas?\s+unidades/i, label: 'escasez: «últimas unidades»' },
  // Urgencia genérica sin dato real de stock (frases vistas en las fichas 81–91).
  { re: /quedan\s+pocas|pocas\s+unidades|unos\s+pocos\s+productos|stock\s+limitado|cantidad\s+limitada|unidades\s+(disponibles\s+)?(est[aá]n|son)\s+limitadas|se\s+est[aá]n?\s+agotando|antes\s+de\s+que\s+se\s+(agoten|acaben)|la\s+demanda\s+sigue\s+(subiendo|creciendo)/i, label: 'escasez sin dato de stock' },
  { re: /sin\s+dolor/i, label: 'salud: «sin dolor»' },
  { re: /protecci[oó]n\s+(uv|solar)|filtro\s+uv|uv\s*400/i, label: 'protección UV/solar sin certificación', unlessRe: /certific/i },
];

const sug = {
  hide: { action: 'hide', label: 'Ocultar de la tienda', params: {} },
  keep: { action: 'keep', label: 'Mantener como está (asumo el riesgo)', params: {} },
  bundle: { action: 'bundle_only', label: 'Vender solo en combo o como añadido a otro pedido', params: {} },
  price: (price, basis) => ({ action: 'set_price', label: `Subir el PVP a ${price.toFixed(2)} (${basis})`, params: { price, basis } }),
};

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const dropiIdOf = (p) => str(p.dropiProductId) || (p.sourceProvider === 'dropi' ? str(p.externalId) : '');

function issue(productId, type, severity, title, details, suggestions, fingerprint) {
  return { productId, type, severity, title, details, suggestions, fingerprint };
}

// ── Detección por producto (scan) — PURA ─────────────────────────────────────
function detectProduct(p) {
  const out = [];
  const dropiId = dropiIdOf(p);
  const text = `${str(p.name)}\n${str(p.description)}`;
  const cat = str(p.categoryName);

  if (!dropiId && p.sourceProvider !== 'effi') {
    out.push(issue(p.id, 'missing_dropi_id', 'medium', 'Sin ID de Dropi: no se puede despachar automáticamente',
      { sourceProvider: p.sourceProvider ?? null }, [sug.hide, sug.keep], 'none'));
  }

  if (dropiId && !(p.costPrice > 0)) {
    // low: el análisis offline (import) puede tener el coste; aquí solo falta en la ficha (costPrice).
    out.push(issue(p.id, 'missing_cost', 'low', 'Sin coste en la ficha (costPrice): el scan no puede calcular el margen',
      { dropiProductId: dropiId }, [sug.keep], `cost:${dropiId}`));
  } else if (p.costPrice > 0 && p.price > 0) {
    const input = { pvp: p.price, cost: p.costPrice, costIncludesVat: null, shipping: null, returnCost: null,
      returnRate: null, deliveryRate: null, commissionRate: SCAN_COMMISSION, assumptions: SCAN_ASSUMPTIONS };
    const r = contributionPerOrder(input);
    const [cMin, cMax] = r.range.contribution;
    const mMin = r.range.marginOnNet ? r.range.marginOnNet[0] : null;
    const min = minProfitablePrice({ ...input, targetMargin: THIN_MARGIN });
    const details = { pvp: p.price, cost: p.costPrice, contribution: [cMin, cMax], marginOnNet: r.range.marginOnNet,
      minProfitablePvp: min.minPvp, assumptions: { ...SCAN_ASSUMPTIONS, commissionRate: SCAN_COMMISSION }, basis: 'scan (flete estimado)' };
    const fp = `m:${p.price}|${p.costPrice}`;
    const priceSug = min.valid ? [sug.price(min.minPvp, `mínimo con margen ${THIN_MARGIN * 100}% en el peor supuesto`)] : [];
    if (cMin < 0) {
      out.push(issue(p.id, 'negative_margin', cMax < 0 ? 'critical' : 'high',
        cMax < 0 ? 'Pierde dinero en todos los supuestos' : 'Pierde dinero con rechazo/flete altos',
        details, [...priceSug, sug.bundle, sug.hide, sug.keep], fp));
    } else if (mMin !== null && mMin < THIN_MARGIN) {
      out.push(issue(p.id, 'thin_margin', 'medium', `Margen fino (< ${THIN_MARGIN * 100}% en el peor supuesto)`,
        details, [...priceSug, sug.bundle, sug.keep], fp));
    }
  }

  if (p.stock === 0 && dropiId) {
    out.push(issue(p.id, 'dropi_out_of_stock', 'high', 'Sin stock', { stock: 0, dropiProductId: dropiId }, [sug.hide, sug.keep], 's:0'));
  } else if (p.stock !== null && p.stock !== undefined && p.stock >= 0 && p.stock <= LOW_STOCK) {
    out.push(issue(p.id, 'low_stock', 'medium', `Stock bajo (${p.stock})`, { stock: p.stock, threshold: LOW_STOCK }, [sug.hide, sug.keep], 's:low'));
  }

  if (RISKY_RE.test(cat) || RISKY_RE.test(str(p.name))) {
    out.push(issue(p.id, 'risky_category', 'high', 'Categoría de riesgo (vapeo/adultos)', { category: cat || null },
      [sug.hide, sug.keep], `cat:${cat}`));
  }

  const found = CLAIMS.filter((c) => c.re.test(text) && !(c.unlessRe && c.unlessRe.test(text)));
  if (found.length) {
    const matches = found.map((c) => ({ claim: c.label, excerpt: excerpt(text, c.re) }));
    out.push(issue(p.id, 'unverified_claims', 'high', 'Promesas o escasez no verificadas en la ficha', { matches },
      [{ action: 'keep', label: 'Mantener (el texto se corrige editando la ficha)', params: {} }, sug.hide],
      `claims:${found.map((c) => c.label).join('|')}`));
  }
  return out;
}

function excerpt(text, re) {
  const m = re.exec(text);
  if (!m) return '';
  return text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Import del análisis offline (columnas de margenes.csv) ───────────────────
const num = Joi.number().allow(null).empty('');
const idStr = Joi.alternatives().try(Joi.number().integer().positive(), Joi.string().trim().pattern(/^\d{1,12}$/));
const txt = (max) => Joi.string().allow('', null).max(max);
const candidateSchema = Joi.object({
  id: idStr.required(),
  name: txt(300), cost: num.min(0), stock: Joi.number().integer().allow(null).empty(''),
  supplier: txt(200), imageUrl: Joi.string().max(1000).pattern(/^https?:\/\/\S+$/).allow('', null),
  confidence: Joi.string().valid('alta', 'media', 'baja').allow('', null), evidence: txt(1000),
});
const rowSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  nombre: txt(300), categoria: txt(200),
  dropi_id: Joi.alternatives().try(idStr, Joi.string().valid('')).allow(null),
  pvp: num.min(0), coste: num.min(0), stock: Joi.number().integer().min(0).allow(null).empty(''), flete: num.min(0),
  contrib_r15: num, contrib_r30: num, margen_r15_pct: num, pvp_equilibrio_r30: num.min(0),
  fuente_coste: txt(500), fuente_flete: txt(500), estado: txt(1000),
  alternativas: Joi.alternatives().try(txt(2000), Joi.array().max(10).items(candidateSchema)),
}).unknown(true);
const importSchema = Joi.object({ rows: Joi.array().min(1).max(2000).items(rowSchema).required() });
const decisionSchema = Joi.object({
  action: Joi.string().valid(...ACTIONS).required(),
  params: Joi.when('action', {
    switch: [
      { is: 'swap_dropi_id', then: Joi.object({ dropiProductId: Joi.string().trim().pattern(/^\d{1,12}$/).required() }).unknown(true).required() },
      { is: 'set_price', then: Joi.object({ price: Joi.number().positive().max(100000) }).unknown(true) },
    ],
    otherwise: Joi.object().unknown(true),
  }),
  note: Joi.string().allow('').max(1000),
});

/** "185342;73340" o "182227:Protector bucal:7.5:100" (separador ; o |). */
function parseAlternatives(v) {
  if (Array.isArray(v)) return v.map((c) => ({ ...c, id: String(c.id) }));
  return str(v).split(/[;|]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [id, name, cost, stock] = s.split(':').map((x) => x.trim());
    if (!/^\d{1,12}$/.test(id)) throw boom.badRequest(`alternativas: id inválido «${id}»`);
    return { id, name: name || null, cost: cost ? Number(cost) : null, stock: stock ? parseInt(stock, 10) : null };
  });
}

function candidateLabel(c) {
  const bits = [c.name, c.cost != null ? `coste ${c.cost}` : null, c.stock != null ? `stock ${c.stock}` : null,
    c.confidence ? `confianza ${c.confidence}` : null].filter(Boolean);
  return `Cambiar a Dropi ${c.id}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
}

/** Detección por fila del análisis offline — PURA (candidatos ya resueltos). */
function detectRow(row, productId, candidates = []) {
  const out = [];
  const est = str(row.estado);
  const dropiId = str(row.dropi_id);
  const base = { source: 'margenes.csv', estado: est || null, dropiProductId: dropiId || null };

  if (!dropiId || /SIN_DROPI_ID/.test(est)) {
    out.push(issue(productId, 'missing_dropi_id', 'medium', 'Sin ID de Dropi: no se puede despachar automáticamente',
      base, [sug.hide, sug.keep], 'none'));
  } else if (/NO_ENCONTRADO/.test(est)) {
    out.push(issue(productId, 'dropi_not_found', 'critical', `El producto ${dropiId} ya no existe en Dropi`,
      { ...base, pvp: row.pvp ?? null, candidates },
      [...candidates.map((c) => ({ action: 'swap_dropi_id', label: candidateLabel(c), params: { dropiProductId: c.id, candidate: c } })), sug.hide, sug.keep],
      `dropi:${dropiId}`));
  } else {
    if (row.coste === undefined || row.coste === null) {
      out.push(issue(productId, 'missing_cost', 'medium', 'Sin coste de proveedor: no se puede calcular el margen', base, [sug.keep], `cost:${dropiId}`));
    } else {
      const details = { ...base, pvp: row.pvp ?? null, cost: row.coste, freight: row.flete ?? null, freightSource: str(row.fuente_flete) || null,
        contribR15: row.contrib_r15 ?? null, contribR30: row.contrib_r30 ?? null, marginR15Pct: row.margen_r15_pct ?? null,
        breakEvenPvpR30: row.pvp_equilibrio_r30 ?? null };
      const fp = `m:${row.pvp}|${row.coste}`; // = fingerprint del scan: una decisión vale para ambas fuentes
      const priceSug = row.pvp_equilibrio_r30 > 0 ? [sug.price(row.pvp_equilibrio_r30, 'PVP de equilibrio con rechazo 30%')] : [];
      if (row.contrib_r15 < 0 || row.contrib_r30 < 0) {
        const both = row.contrib_r15 < 0;
        out.push(issue(productId, 'negative_margin', both ? 'critical' : 'high',
          both ? 'Pierde dinero con rechazo 15% y 30%' : 'Pierde dinero con rechazo 30%', details,
          [...priceSug, sug.bundle, sug.hide, sug.keep], fp));
      } else if (row.contrib_r30 < THIN_CONTRIB_USD || row.margen_r15_pct < THIN_MARGIN * 100) {
        out.push(issue(productId, 'thin_margin', 'medium', 'Margen fino', details, [...priceSug, sug.bundle, sug.keep], fp));
      }
      if (/^ESTIMADO/i.test(str(row.fuente_flete))) {
        out.push(issue(productId, 'missing_freight', 'low', 'Flete estimado: falta cotización real',
          { ...base, freight: row.flete ?? null, freightSource: str(row.fuente_flete) }, [sug.keep], `f:${row.flete}`));
      }
    }
    if (row.stock === 0) {
      out.push(issue(productId, 'dropi_out_of_stock', 'high', 'Sin stock en Dropi', { ...base, stock: 0 }, [sug.hide, sug.keep], 's:0'));
    } else if (row.stock !== null && row.stock !== undefined && row.stock <= LOW_STOCK) {
      out.push(issue(productId, 'low_stock', 'medium', `Stock bajo en Dropi (${row.stock})`, { ...base, stock: row.stock, threshold: LOW_STOCK }, [sug.hide, sug.keep], 's:low'));
    }
  }
  if (/RIESGO_CATEGORIA/.test(est) || RISKY_RE.test(str(row.categoria)) || RISKY_RE.test(str(row.nombre))) {
    out.push(issue(productId, 'risky_category', 'high', 'Categoría de riesgo (vapeo/adultos)', { ...base, category: str(row.categoria) || null },
      [sug.hide, sug.keep], `cat:${str(row.categoria)}`));
  }
  return out;
}

// ── Persistencia ─────────────────────────────────────────────────────────────
const sel = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/**
 * Upsert de los issues detectados + resolución de los que desaparecieron.
 * `scope` limita la resolución: scan → todos los issues 'scan'; import → issues
 * 'import' de los productos importados. Un scan no pisa un issue de import (datos reales).
 */
async function persist(detected, source, scopeProductIds, transaction) {
  const closed = await sel(`
    SELECT DISTINCT ON (product_id, type) product_id, type, fingerprint
      FROM catalog_issues WHERE status IN ('decided','dismissed')
     ORDER BY product_id, type, decided_at DESC NULLS LAST, id DESC`, {}, transaction);
  const decidedFp = new Map(closed.map((r) => [`${r.product_id}:${r.type}`, r.fingerprint]));

  let created = 0;
  let updated = 0;
  const keys = [];
  for (const it of detected) {
    if (decidedFp.get(`${it.productId}:${it.type}`) === it.fingerprint) continue; // ya decidido, mismo problema
    keys.push({ p: it.productId, t: it.type });
    const rows = await sel(`
      INSERT INTO catalog_issues (product_id, type, severity, title, details, suggestions, source, fingerprint, status, created_at, updated_at)
      VALUES (:productId, :type, :severity, :title, CAST(:details AS jsonb), CAST(:suggestions AS jsonb), :source, :fingerprint, 'open', now(), now())
      ON CONFLICT (product_id, type) WHERE status = 'open' DO UPDATE SET
        severity = EXCLUDED.severity, title = EXCLUDED.title, details = EXCLUDED.details,
        suggestions = EXCLUDED.suggestions, source = EXCLUDED.source, fingerprint = EXCLUDED.fingerprint, updated_at = now()
      WHERE (catalog_issues.source = 'scan' OR EXCLUDED.source = 'import')
        AND (catalog_issues.details IS DISTINCT FROM EXCLUDED.details
          OR catalog_issues.suggestions IS DISTINCT FROM EXCLUDED.suggestions
          OR catalog_issues.severity IS DISTINCT FROM EXCLUDED.severity
          OR catalog_issues.source IS DISTINCT FROM EXCLUDED.source)
      RETURNING (xmax = 0) AS inserted`, {
      ...it, source, details: JSON.stringify(it.details), suggestions: JSON.stringify(it.suggestions),
    }, transaction);
    if (rows.length) rows[0].inserted ? created++ : updated++;
  }

  const resolvedRows = await sel(`
    UPDATE catalog_issues SET status = 'resolved', resolved_at = now(), updated_at = now()
     WHERE status = 'open' AND source = :source
       ${scopeProductIds ? 'AND product_id IN (SELECT CAST(x AS int) FROM jsonb_array_elements_text(CAST(:pids AS jsonb)) x)' : ''}
       AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(CAST(:keys AS jsonb)) AS k(p int, t text)
                        WHERE k.p = catalog_issues.product_id AND k.t = catalog_issues.type)
    RETURNING id`, { source, keys: JSON.stringify(keys), pids: JSON.stringify(scopeProductIds || []) }, transaction);

  return { created, updated, resolved: resolvedRows.length };
}

async function scan() {
  return sequelize.transaction(async (transaction) => {
    const products = await models.Product.findAll({
      where: { isDeleted: false, showShop: true },
      include: [{ association: 'category', attributes: ['name'] }],
      transaction,
    });
    const detected = products.flatMap((p) => detectProduct({ ...p.toJSON(), categoryName: p.category?.name }));
    return persist(detected, 'scan', null, transaction);
  });
}

/** Candidatos de Dropi por nombre (solo lectura). Nunca lanza: sin catálogo → []. */
async function searchCandidates(name) {
  try {
    const { searchByText } = require('../integrations/dropi/dropiSearchService');
    const { products = [] } = await searchByText(name, { limit: 5 });
    return products.slice(0, 3).map((c) => ({ id: String(c.externalId), name: c.title, cost: c.price, stock: c.stock, evidence: 'búsqueda por nombre (sin verificar)', confidence: 'baja' }));
  } catch (err) {
    console.warn('[catalog-health] búsqueda de candidatos en Dropi falló:', err.message);
    return [];
  }
}

async function importRows(body, { search = searchCandidates } = {}) {
  const { rows } = Joi.attempt(body, importSchema, { abortEarly: false, stripUnknown: true });
  const ids = [...new Set(rows.map((r) => r.id))];
  const products = await models.Product.findAll({ where: { id: ids } });
  const byId = new Map(products.map((p) => [p.id, p]));

  const detected = [];
  const skipped = [];
  const imported = [];
  for (const row of rows) {
    const p = byId.get(row.id);
    if (!p) { skipped.push({ id: row.id, reason: 'el producto no existe' }); continue; }
    const current = dropiIdOf(p);
    if (str(row.dropi_id) !== current) { // análisis desactualizado (p. ej. ID ya cambiado)
      skipped.push({ id: row.id, reason: `dropi_id del análisis (${str(row.dropi_id) || 'vacío'}) distinto del actual (${current || 'vacío'})` });
      continue;
    }
    let candidates = [];
    if (/NO_ENCONTRADO/.test(str(row.estado)) && str(row.dropi_id)) {
      candidates = row.alternativas ? parseAlternatives(row.alternativas) : await search(str(row.nombre) || p.name);
    }
    imported.push(row.id);
    detected.push(...detectRow(row, row.id, candidates));
  }
  const result = await sequelize.transaction((t) => persist(detected, 'import', imported, t));
  return { ...result, skipped };
}

// ── Lectura y decisión ───────────────────────────────────────────────────────
function serialize(i) {
  const p = i.product || {};
  const closedByDecision = i.status === 'decided' || i.status === 'dismissed';
  return {
    id: i.id, productId: i.productId, productName: p.name ?? null, productPrice: p.price ?? null,
    dropiProductId: p.dropiProductId || (p.sourceProvider === 'dropi' ? p.externalId : null) || null,
    type: i.type, severity: i.severity, title: i.title, details: i.details, suggestions: i.suggestions, status: i.status,
    decision: closedByDecision ? { action: i.decisionAction, params: i.decisionParams, note: i.decisionNote, decidedBy: i.decidedBy, decidedAt: i.decidedAt } : null,
    createdAt: i.createdAt, updatedAt: i.updatedAt,
  };
}

const productInclude = { association: 'product', attributes: ['id', 'name', 'price', 'dropiProductId', 'externalId', 'sourceProvider'] };

// ponytail: sin paginación (catálogo de decenas de productos); añadir limit/offset si crece.
async function list(status = 'open') {
  const where = status === 'all' ? {} : { status };
  const issues = await models.CatalogIssue.findAll({ where, include: [productInclude] });
  const items = issues.map((i) => serialize(i.toJSON()))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.productId - b.productId || a.id - b.id);
  const counts = await sel(`SELECT severity, count(*)::int AS n FROM catalog_issues WHERE status = 'open' GROUP BY severity`);
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of counts) bySeverity[c.severity] = c.n;
  return { generatedAt: new Date().toISOString(), summary: { open: Object.values(bySeverity).reduce((a, b) => a + b, 0), bySeverity }, items };
}

/**
 * Registra la decisión. Aplica en la misma transacción SOLO hide y swap_dropi_id;
 * set_price y bundle_only se registran (se aplican con la edición de producto).
 */
async function decide(id, body, userId) {
  const { action, params = {}, note } = Joi.attempt(body, decisionSchema, { abortEarly: false });
  await sequelize.transaction(async (transaction) => {
    const it = await models.CatalogIssue.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!it) throw boom.notFound('issue no encontrado');
    if (it.status !== 'open') throw boom.conflict(`el issue ya está ${it.status}`);
    const recorded = { ...params };

    if (action === 'hide' || action === 'swap_dropi_id') {
      const p = await models.Product.findByPk(it.productId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!p) throw boom.notFound('producto no encontrado');
      if (action === 'hide') {
        recorded.previousShowShop = p.showShop;
        await p.update({ showShop: false }, { transaction });
      } else {
        const next = params.dropiProductId.trim();
        const prev = dropiIdOf(p) || null;
        const items = Array.isArray(p.dropiItems) ? p.dropiItems : [];
        // Presentaciones: el ID Dropi vive en dropiId; `id` es la clave que eligió el cliente.
        const matched = prev && items.some((x) => String(x?.dropiId ?? x?.id) === prev);
        if (!matched && p.isBundle === true && items.length) {
          throw boom.badData('producto pack: el ID anterior no está en sus componentes; edita el pack manualmente');
        }
        const swap = (x) => (x?.dropiId != null ? { ...x, dropiId: next } : { ...x, id: next });
        const dropiItems = matched ? items.map((x) => (String(x?.dropiId ?? x?.id) === prev ? swap(x) : x)) : [{ id: next, qty: 1 }];
        Object.assign(recorded, { dropiProductId: next, previousDropiProductId: prev, previousDropiItems: p.dropiItems ?? null });
        await p.update({ dropiProductId: next, dropiItems }, { transaction });
      }
    }

    await it.update({
      status: action === 'dismiss' ? 'dismissed' : 'decided',
      decisionAction: action, decisionParams: recorded, decisionNote: note || null,
      decidedBy: Number.isInteger(Number(userId)) ? Number(userId) : null, decidedAt: new Date(),
    }, { transaction });
  });
  const fresh = await models.CatalogIssue.findByPk(id, { include: [productInclude] });
  return serialize(fresh.toJSON());
}

module.exports = {
  TYPES, ACTIONS, LOW_STOCK, THIN_MARGIN, SCAN_ASSUMPTIONS,
  importSchema, decisionSchema, detectProduct, detectRow, parseAlternatives,
  scan, importRows, list, decide,
};
