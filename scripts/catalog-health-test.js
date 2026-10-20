'use strict';
/* eslint-disable no-console */
/**
 * Salud del catálogo — test suite.
 *
 * Parte A (siempre, sin BD ni red): detección por tipo (import y scan), validación Joi,
 *   parser CSV del seed y autorización 401/403/400 del router real.
 * Parte B (solo con CATALOG_TEST_DATABASE_URL): Postgres REAL en un schema temporal
 *   catalog_test_<pid> (search_path) que se borra al terminar. Aborta si el host parece
 *   producción (roundhouse*). Migración up/down/up, scan idempotente, import, decisiones
 *   aplicadas, 409, concurrencia, no reapertura de lo decidido, resolución.
 *   Con CATALOG_HEALTH_CSV (+ opcional CATALOG_HEALTH_EQUIV y CATALOG_HEALTH_PRODUCTS_JSON)
 *   carga además el análisis real y comprueba los casos conocidos.
 *
 * Usage: [CATALOG_TEST_DATABASE_URL=postgres://…] node scripts/catalog-health-test.js
 */
const fs = require('fs');

Object.assign(process.env, { JWT_SECRET: 'test-jwt-secret-only', DROPI_MOCK: 'true' });
delete process.env.DROPI_WORKER_URL;
delete process.env.DROPI_WORKER_KEY;

const logs = [];
const out = (...a) => (console._log || console.log)(...a);
for (const level of ['log', 'warn', 'error', 'info']) {
  console[`_${level}`] = console[level];
  console[level] = (...args) => logs.push(args.map(String).join(' '));
}
let passed = 0;
let failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { out(`  ✅ ${label}`); passed++; } else { console._error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}
const types = (list) => list.map((i) => i.type).sort().join(',');
const find = (list, t) => list.find((i) => i.type === t);

// Filas sintéticas con la forma de margenes.csv (no son datos reales).
const ROWS = {
  notFound: { id: 1, nombre: 'Fuente agua gatos', categoria: 'Mascotas', dropi_id: '9001', pvp: 29.99, estado: 'NO_ENCONTRADO: no vender sin confirmar', alternativas: '9101:Fuente 2 en 1:18.5:98;9102' },
  lossBoth: { id: 2, nombre: 'Parlante mini', categoria: 'Electrónica', dropi_id: '9002', pvp: 10, coste: 2.99, stock: '', flete: 5.19, fuente_flete: 'REAL', contrib_r15: -1.38, contrib_r30: -2.97, margen_r15_pct: -13.8, pvp_equilibrio_r30: 15.05, estado: 'PIERDE_DINERO_r30; PIERDE_DINERO_r15' },
  loss30: { id: 3, nombre: 'Kit', categoria: 'Electrónica', dropi_id: '9003', pvp: 165, coste: 115, stock: 93, flete: 14.47, fuente_flete: 'ESTIMADO (como 7267)', contrib_r15: 3.35, contrib_r30: -2.35, margen_r15_pct: 2, pvp_equilibrio_r30: 168.99, estado: 'PIERDE_DINERO_r30' },
  thinOut: { id: 4, nombre: 'Guantes', categoria: 'Deporte', dropi_id: '9004', pvp: 32, coste: 15.5, stock: 0, flete: 5.54, fuente_flete: 'REAL', contrib_r15: 3.29, contrib_r30: 0.76, margen_r15_pct: 10.3, pvp_equilibrio_r30: 30.71, estado: 'STOCK_0' },
  low: { id: 5, nombre: 'Cámara', categoria: 'Electrónica', dropi_id: '9005', pvp: 70, coste: 30, stock: 3, flete: 5.54, fuente_flete: 'REAL', contrib_r15: 20, contrib_r30: 15, margen_r15_pct: 30, pvp_equilibrio_r30: 40, estado: 'OK' },
  noId: { id: 6, nombre: 'Dron', categoria: 'Electrónica', dropi_id: '', pvp: 50, estado: 'SIN_DROPI_ID (fuera de alcance)' },
  risky: { id: 7, nombre: 'Cigarrillos de sabores', categoria: 'Vaporizadores', dropi_id: '9007', pvp: 30, coste: 10, stock: 50, flete: 5.54, fuente_flete: 'REAL', contrib_r15: 10, contrib_r30: 8, margen_r15_pct: 40, pvp_equilibrio_r30: 20, estado: 'RIESGO_CATEGORIA' },
  noCost: { id: 8, nombre: 'Algo', categoria: 'Hogar', dropi_id: '9008', pvp: 20, coste: '', estado: '' },
};

// ── Parte A ──────────────────────────────────────────────────────────────────
async function partA() {
  const Joi = require('joi');
  const svc = require('../Services/catalogHealthService');
  const { parseCsv, equivalencesByProduct } = require('./catalog-health-seed');
  const norm = (r) => Joi.attempt({ rows: [r] }, svc.importSchema, { stripUnknown: true }).rows[0];
  const row = (k, cands = []) => svc.detectRow(norm(ROWS[k]), ROWS[k].id, cands);

  out('\n▶ A1. Detección desde el análisis offline (import)');
  const nf = row('notFound', svc.parseAlternatives(norm(ROWS.notFound).alternativas));
  assert('NO_ENCONTRADO → dropi_not_found critical', types(nf) === 'dropi_not_found' && nf[0].severity === 'critical');
  const swaps = nf[0].suggestions.filter((s) => s.action === 'swap_dropi_id');
  assert('alternativas → sugerencias swap_dropi_id con id/nombre/coste/stock', swaps.length === 2 && swaps[0].params.dropiProductId === '9101'
    && swaps[0].params.candidate.cost === 18.5 && swaps[0].params.candidate.stock === 98 && nf[0].details.candidates.length === 2);
  assert('dropi_not_found también sugiere ocultar y mantener', ['hide', 'keep'].every((a) => nf[0].suggestions.some((s) => s.action === a)));
  const lb = row('lossBoth');
  assert('pierde con r15 y r30 → negative_margin critical', find(lb, 'negative_margin')?.severity === 'critical');
  assert('negative_margin sugiere set_price (PVP de equilibrio) y bundle_only', find(lb, 'negative_margin').suggestions[0].action === 'set_price'
    && find(lb, 'negative_margin').suggestions[0].params.price === 15.05 && find(lb, 'negative_margin').suggestions.some((s) => s.action === 'bundle_only'));
  assert('stock vacío → sin issue de stock; flete REAL → sin missing_freight', types(lb) === 'negative_margin');
  const l30 = row('loss30');
  assert('pierde solo con r30 → negative_margin high + missing_freight low', find(l30, 'negative_margin')?.severity === 'high' && find(l30, 'missing_freight')?.severity === 'low');
  assert('contribución r30 < 1 → thin_margin; stock 0 → dropi_out_of_stock high', types(row('thinOut')) === 'dropi_out_of_stock,thin_margin' && find(row('thinOut'), 'dropi_out_of_stock').severity === 'high');
  assert('stock 3 → low_stock medium (sin problema de margen)', types(row('low')) === 'low_stock');
  assert('sin dropi_id → missing_dropi_id', types(row('noId')) === 'missing_dropi_id');
  assert('RIESGO_CATEGORIA → risky_category high', types(row('risky')) === 'risky_category' && row('risky')[0].severity === 'high');
  assert('sin coste → missing_cost', types(row('noCost')) === 'missing_cost');
  assert('fingerprint estable entre llamadas', JSON.stringify(row('lossBoth').map((i) => i.fingerprint)) === JSON.stringify(lb.map((i) => i.fingerprint)));

  out('\n▶ A2. Detección por reglas sobre la BD (scan)');
  const base = { id: 50, name: 'Producto', description: 'Texto normal.', price: 70, costPrice: 20, stock: 100, dropiProductId: '123', sourceProvider: 'dropi', categoryName: 'Hogar' };
  const scan = (o) => svc.detectProduct({ ...base, ...o });
  assert('producto sano → sin issues', scan({}).length === 0, types(scan({})));
  const mica = scan({ price: 3.99, costPrice: 0.75 });
  assert('PVP 3.99 / coste 0.75 → negative_margin critical con set_price = PVP mínimo rentable', find(mica, 'negative_margin')?.severity === 'critical'
    && find(mica, 'negative_margin').suggestions[0].action === 'set_price' && find(mica, 'negative_margin').details.minProfitablePvp > 10);
  assert('margen fino detectado (PVP 20 / coste 9)', ['thin_margin', 'negative_margin'].includes(scan({ price: 20, costPrice: 9 })[0]?.type));
  assert('sin costPrice con ID Dropi → missing_cost (low)', find(scan({ costPrice: null }), 'missing_cost')?.severity === 'low');
  assert('stock 0 → dropi_out_of_stock; stock 2 → low_stock', types(scan({ stock: 0 })) === 'dropi_out_of_stock' && types(scan({ stock: 2 })) === 'low_stock');
  assert('stock null → sin issue de stock', scan({ stock: null }).length === 0);
  assert('sin ID de Dropi → missing_dropi_id; effi no', types(scan({ dropiProductId: null, sourceProvider: null })) === 'missing_dropi_id' && scan({ dropiProductId: null, sourceProvider: 'effi' }).length === 0);
  assert('externalId de Dropi cuenta como ID', scan({ dropiProductId: null, externalId: '777' }).length === 0);
  assert('categoría Vaporizadores / Sex Shop → risky_category', types(scan({ categoryName: 'Vaporizadores' })) === 'risky_category' && types(scan({ categoryName: 'Sex Shop' })) === 'risky_category');
  const claims = [
    ['> ¡Solo quedan 3 unidades!', 'solo quedan'], ['Últimas unidades disponibles', 'últimas'], ['Afeitado sin dolor', 'sin dolor'],
    ['Con protección UV para tus ojos', 'UV'], ['Disponible en una cantidad limitada', 'cantidad limitada'],
    ['Las unidades disponibles son limitadas y la demanda sigue subiendo', 'limitadas'], ['antes de que se acaben', 'se acaben'],
  ];
  for (const [txt, l] of claims) assert(`unverified_claims: «${l}»`, find(scan({ description: txt }), 'unverified_claims')?.severity === 'high');
  assert('protección UV CON certificación → no se marca', !find(scan({ description: 'Protección UV400 con certificación CE' }), 'unverified_claims'));
  assert('claims incluye extracto sin HTML', find(scan({ description: '<p>Hoy <b>solo quedan</b> 2</p>' }), 'unverified_claims').details.matches[0].excerpt.includes('solo quedan'));

  out('\n▶ A3. Validación de entrada');
  const bad = (schema, v) => !!schema.validate(v, { abortEarly: false }).error;
  assert('import: rows vacío / sin id / id no numérico rechazados', bad(svc.importSchema, { rows: [] }) && bad(svc.importSchema, { rows: [{ nombre: 'x' }] }) && bad(svc.importSchema, { rows: [{ id: 'abc' }] }));
  assert('import: dropi_id no numérico / stock negativo / pvp negativo rechazados', bad(svc.importSchema, { rows: [{ id: 1, dropi_id: '12a' }] })
    && bad(svc.importSchema, { rows: [{ id: 1, stock: -1 }] }) && bad(svc.importSchema, { rows: [{ id: 1, pvp: -5 }] }));
  assert('import: > 2000 filas rechazado', bad(svc.importSchema, { rows: Array.from({ length: 2001 }, (_, i) => ({ id: i + 1 })) }));
  assert('import: strings numéricos y vacíos del CSV aceptados', !bad(svc.importSchema, { rows: [{ id: '5', pvp: '10.5', coste: '', stock: '', contrib_r15: '-1.2', extra: 'x' }] }));
  assert('import: alternativas con imageUrl no http rechazada', bad(svc.importSchema, { rows: [{ id: 1, alternativas: [{ id: '1', imageUrl: 'javascript:alert(1)' }] }] }));
  assert('decision: acción desconocida rechazada', bad(svc.decisionSchema, { action: 'delete' }));
  assert('decision: swap sin dropiProductId / no numérico rechazado', bad(svc.decisionSchema, { action: 'swap_dropi_id' }) && bad(svc.decisionSchema, { action: 'swap_dropi_id', params: { dropiProductId: 'abc' } }));
  assert('decision: set_price negativo rechazado; nota > 1000 rechazada', bad(svc.decisionSchema, { action: 'set_price', params: { price: -1 } }) && bad(svc.decisionSchema, { action: 'keep', note: 'x'.repeat(1001) }));
  assert('decision: válidas aceptadas', !bad(svc.decisionSchema, { action: 'swap_dropi_id', params: { dropiProductId: '185342' }, note: 'ok' }) && !bad(svc.decisionSchema, { action: 'hide' }));
  let threw = false;
  try { svc.parseAlternatives('12;abc'); } catch (e) { threw = e.isBoom && e.output.statusCode === 400; }
  assert('alternativas en texto con id inválido → 400', threw);

  out('\n▶ A4. Parser CSV del seed');
  const csv = parseCsv('id,nombre,fuente\n1,"Silla, roja","dice ""hola"""\r\n2,b,\n\n');
  assert('comillas, comas y "" escapadas; filas vacías ignoradas', csv.length === 2 && csv[0].nombre === 'Silla, roja' && csv[0].fuente === 'dice "hola"' && csv[1].fuente === '');
  const eq = equivalencesByProduct(parseCsv('product_id,candidato_id,candidato_nombre,coste,stock,confianza\n82,1,a,1,2,baja\n82,2,b,3,4,alta\n83,,sin candidatos,,,\n'));
  assert('equivalencias agrupadas por producto, ordenadas por confianza, sin filas vacías', eq.get(82)[0].id === '2' && eq.get(82).length === 2 && !eq.has(83));

  out('\n▶ A5. Autorización del router (401/403/400 antes de tocar la BD)');
  const { server, call } = await startApp();
  try {
    assert('sin token → 401', (await call('GET', '/', null, null)).status === 401);
    assert('rol customer → 403', (await call('GET', '/', null, tok('customer'))).status === 403);
    assert('rol customer en POST /scan → 403', (await call('POST', '/scan', null, tok('customer'))).status === 403);
    assert('admin con status inválido → 400', (await call('GET', '/?status=xx')).status === 400);
    assert('admin con acción inválida → 400', (await call('POST', '/1/decision', { action: 'nuke' })).status === 400);
    assert('admin con id no numérico → 400', (await call('POST', '/abc/decision', { action: 'keep' })).status === 400);
    assert('admin con import vacío → 400', (await call('POST', '/import', { rows: [] })).status === 400);
  } finally { server.close(); }
}

function tok(role, sub = 1) {
  return require('jsonwebtoken').sign({ sub, role }, process.env.JWT_SECRET);
}

async function startApp() {
  const express = require('express');
  require('../utils/auth');
  const { boomErrorHandler, ormErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/catalog-health', require('../routes/catalogHealthRouter'));
  app.use(ormErrorHandler);
  app.use(boomErrorHandler);
  app.use(errorHandler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/catalog-health`;
  const admin = tok('admin', 7);
  const call = async (method, p, body, t = admin) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { server, call };
}

// ── Parte B: Postgres real en schema temporal ────────────────────────────────
async function setupDb() {
  const raw = process.env.CATALOG_TEST_DATABASE_URL;
  const host = new URL(raw).hostname;
  if (/^roundhouse/i.test(host)) { console._error('ABORT: el host parece PRODUCCIÓN'); process.exit(2); }
  if (!/^(altaria|localhost$|127\.0\.0\.1$)/.test(host)) { console._error('ABORT: host no reconocido como staging/local'); process.exit(2); }
  const schema = `catalog_test_${process.pid}`;
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
  const qi = sequelize.getQueryInterface();
  const { models } = sequelize;
  const sel = (sql, r = {}) => sequelize.query(sql, { replacements: r, type: QueryTypes.SELECT });
  const mig = require('../db/migrations/20261020000001-create-catalog-issues');
  const { ProductSchema } = require('../db/models/productModel');
  const { CategorySchema } = require('../db/models/categoryModel');
  const { server, call } = await startApp();
  try {
    out(`\n▶ B0. Esquema temporal ${schema} y migración`);
    const [{ sp }] = await sel('SELECT current_schema() AS sp');
    assert('conexión aislada en el schema temporal', sp === schema);
    const noRefs = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => { const { references, onUpdate, onDelete, ...rest } = v; return [k, rest]; })); // eslint-disable-line no-unused-vars
    await qi.createTable('categories', CategorySchema);
    await qi.createTable('products', noRefs(ProductSchema));
    await mig.up(qi);
    await mig.down(qi);
    const gone = (await sel("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = :s AND table_name = 'catalog_issues'", { s: schema }))[0].n === 0;
    await mig.up(qi);
    await mig.up(qi); // idempotente
    const idx = await sel("SELECT indexdef FROM pg_indexes WHERE schemaname = :s AND indexname = 'catalog_issues_open_uniq'", { s: schema });
    assert('migración up → down (tabla borrada) → up → up idempotente', gone && idx.length === 1);
    assert('índice único parcial (product_id, type) WHERE status = open', /UNIQUE/.test(idx[0].indexdef) && /WHERE/.test(idx[0].indexdef) && /open/.test(idx[0].indexdef));

    const [hogar, vap] = await models.Category.bulkCreate([{ name: 'Hogar', image: 'x' }, { name: 'Vaporizadores', image: 'x' }]);
    const P = (o) => ({ image: 'x', description: 'Texto normal.', price: 70, costPrice: 20, stock: 100, showShop: true, isDeleted: false, categoryId: hogar.id, sourceProvider: 'dropi', ...o });
    await models.Product.bulkCreate([
      P({ id: 101, name: 'Mica', price: 3.99, costPrice: 0.75, dropiProductId: '18954' }),
      P({ id: 102, name: 'Fuente', dropiProductId: '81542', dropiItems: [{ id: '81542', qty: 1 }], description: '¡Solo quedan pocas unidades!' }),
      P({ id: 103, name: 'Vape', categoryId: vap.id, dropiProductId: '18466' }),
      P({ id: 104, name: 'Sana', dropiProductId: '5000' }),
      P({ id: 105, name: 'Oculta con problema', price: 3.99, costPrice: 0.75, dropiProductId: '6000', showShop: false }),
      P({ id: 106, name: 'Pack', dropiProductId: '7000', isBundle: true, dropiItems: [{ id: '7001', qty: 1 }, { id: '7002', qty: 1 }], stock: 2 }),
    ]);

    out('\n▶ B1. Scan idempotente');
    const s1 = (await call('POST', '/scan')).body;
    const open1 = await sel("SELECT product_id, type FROM catalog_issues WHERE status = 'open' ORDER BY 1, 2");
    assert('primer scan crea issues', s1.created === open1.length && s1.created >= 4 && s1.updated === 0 && s1.resolved === 0, JSON.stringify(s1));
    assert('detecta mica (negative_margin), fuente (claims), vape (risky), pack (low_stock); no la sana ni la oculta',
      ['101:negative_margin', '102:unverified_claims', '103:risky_category', '106:low_stock'].every((k) => open1.some((r) => `${r.product_id}:${r.type}` === k))
      && !open1.some((r) => [104, 105].includes(r.product_id)), JSON.stringify(open1));
    const s2 = (await call('POST', '/scan')).body;
    assert('segundo scan: { created: 0, updated: 0, resolved: 0 }', s2.created === 0 && s2.updated === 0 && s2.resolved === 0, JSON.stringify(s2));
    const [a, b] = await Promise.all([call('POST', '/scan'), call('POST', '/scan')]);
    const dup = await sel("SELECT product_id, type, count(*)::int n FROM catalog_issues WHERE status = 'open' GROUP BY 1, 2 HAVING count(*) > 1");
    assert('dos scans concurrentes no duplican issues abiertos', a.status === 200 && b.status === 200 && dup.length === 0);

    out('\n▶ B2. Import del análisis offline');
    const imp = await call('POST', '/import', { rows: [
      { id: 102, nombre: 'Fuente', categoria: 'Mascotas', dropi_id: '81542', pvp: 29.99, estado: 'NO_ENCONTRADO: no vender sin confirmar', alternativas: '185342:Dispensador:11:556;176296' },
      { id: 101, nombre: 'Mica', categoria: 'Hogar', dropi_id: '18954', pvp: 3.99, coste: 0.75, stock: 619, flete: 5.54, fuente_flete: 'ESTIMADO', contrib_r15: -4.16, contrib_r30: -5.38, margen_r15_pct: -104.3, pvp_equilibrio_r30: 13.15, estado: 'PIERDE_DINERO_r30; PIERDE_DINERO_r15' },
      { id: 104, dropi_id: '9999', estado: 'OK' },
      { id: 99999, dropi_id: '1', estado: 'OK' },
    ] });
    assert('import 200 con created/updated/resolved/skipped', imp.status === 200 && imp.body.created >= 2 && Array.isArray(imp.body.skipped), JSON.stringify(imp.body));
    assert('filas omitidas: producto inexistente y dropi_id distinto del actual', imp.body.skipped.length === 2
      && imp.body.skipped.some((s) => s.id === 99999) && imp.body.skipped.some((s) => s.id === 104 && /distinto/.test(s.reason)));
    const micaIssue = (await sel("SELECT source, details FROM catalog_issues WHERE product_id = 101 AND type = 'negative_margin' AND status = 'open'"))[0];
    assert('import sustituye el issue de scan con datos reales (source=import)', micaIssue.source === 'import' && micaIssue.details.breakEvenPvpR30 === 13.15);
    const s3 = (await call('POST', '/scan')).body;
    const micaAfter = (await sel("SELECT source FROM catalog_issues WHERE product_id = 101 AND type = 'negative_margin' AND status = 'open'"))[0];
    assert('un scan posterior no pisa ni resuelve el issue importado', micaAfter.source === 'import' && s3.resolved === 0, JSON.stringify(s3));
    const imp2 = (await call('POST', '/import', { rows: [{ id: 102, dropi_id: '81542', estado: 'NO_ENCONTRADO', alternativas: '185342:Dispensador:11:556;176296' }, { id: 101, nombre: 'Mica', categoria: 'Hogar', dropi_id: '18954', pvp: 3.99, coste: 0.75, stock: 619, flete: 5.54, fuente_flete: 'ESTIMADO', contrib_r15: -4.16, contrib_r30: -5.38, margen_r15_pct: -104.3, pvp_equilibrio_r30: 13.15, estado: 'PIERDE_DINERO_r30; PIERDE_DINERO_r15' }] })).body;
    assert('reimportar lo mismo es idempotente (created 0, resolved 0)', imp2.created === 0 && imp2.resolved === 0, JSON.stringify(imp2));

    out('\n▶ B3. GET / (contrato)');
    const g = await call('GET', '/');
    const it = g.body.items.find((i) => i.type === 'dropi_not_found');
    assert('forma { generatedAt, summary: { open, bySeverity }, items }', g.status === 200 && typeof g.body.generatedAt === 'string'
      && g.body.summary.open === g.body.items.length && ['critical', 'high', 'medium', 'low'].every((k) => typeof g.body.summary.bySeverity[k] === 'number'));
    assert('item con todos los campos del contrato', it && ['id', 'productId', 'productName', 'productPrice', 'dropiProductId', 'type', 'severity', 'title', 'details', 'suggestions', 'status', 'decision', 'createdAt', 'updatedAt'].every((k) => k in it)
      && it.productName === 'Fuente' && it.dropiProductId === '81542' && it.decision === null);
    assert('ordenado por severidad (critical primero)', g.body.items[0].severity === 'critical');
    assert('sin costPrice en la respuesta (solo coste del análisis en details)', !JSON.stringify(g.body.items.map((i) => Object.keys(i))).includes('costPrice'));

    out('\n▶ B4. Decisiones');
    const swap = await call('POST', `/${it.id}/decision`, { action: 'swap_dropi_id', params: { dropiProductId: '185342' }, note: 'cambio aprobado' });
    const p102 = await models.Product.findByPk(102);
    assert('swap_dropi_id aplicado: dropiProductId y dropiItems actualizados', swap.status === 200 && p102.dropiProductId === '185342' && p102.dropiItems[0].id === '185342' && p102.dropiItems[0].qty === 1);
    assert('decisión registrada con ID anterior, nota y decidedBy', swap.body.status === 'decided' && swap.body.decision.params.previousDropiProductId === '81542'
      && swap.body.decision.params.previousDropiItems[0].id === '81542' && swap.body.decision.note === 'cambio aprobado' && swap.body.decision.decidedBy === 7);
    assert('segunda decisión sobre el mismo issue → 409', (await call('POST', `/${it.id}/decision`, { action: 'hide' })).status === 409);
    assert('issue inexistente → 404', (await call('POST', '/999999/decision', { action: 'keep' })).status === 404);
    assert('GET ?status=decided lo devuelve con decision', (await call('GET', '/?status=decided')).body.items.some((i) => i.id === it.id && i.decision.action === 'swap_dropi_id'));

    const vapeIssue = (await sel("SELECT id FROM catalog_issues WHERE product_id = 103 AND type = 'risky_category' AND status = 'open'"))[0];
    const [h1, h2] = await Promise.all([call('POST', `/${vapeIssue.id}/decision`, { action: 'hide' }), call('POST', `/${vapeIssue.id}/decision`, { action: 'keep' })]);
    assert('dos decisiones concurrentes: una 200 y otra 409', [h1.status, h2.status].sort().join() === '200,409', `${h1.status},${h2.status}`);
    const vapeRow = await models.Product.findByPk(103);
    const winner = h1.status === 200 ? h1.body : h2.body;
    assert('hide aplicado solo si ganó hide (showShop=false)', winner.decision.action === 'hide' ? vapeRow.showShop === false : vapeRow.showShop === true);

    const micaId = (await sel("SELECT id FROM catalog_issues WHERE product_id = 101 AND type = 'negative_margin' AND status = 'open'"))[0].id;
    const sp1 = await call('POST', `/${micaId}/decision`, { action: 'set_price', params: { price: 13.99 } });
    assert('set_price solo se registra (precio sin cambiar)', sp1.status === 200 && (await models.Product.findByPk(101)).price === 3.99 && sp1.body.decision.params.price === 13.99);
    const packIssue = (await sel("SELECT id FROM catalog_issues WHERE product_id = 106 AND status = 'open' LIMIT 1"))[0];
    const badSwap = await call('POST', `/${packIssue.id}/decision`, { action: 'swap_dropi_id', params: { dropiProductId: '8000' } });
    const pack = await models.Product.findByPk(106);
    assert('swap en pack sin el ID anterior → 422 y nada cambia (rollback)', badSwap.status === 422 && pack.dropiProductId === '7000'
      && (await sel('SELECT status FROM catalog_issues WHERE id = :id', { id: packIssue.id }))[0].status === 'open');
    const dis = await call('POST', `/${packIssue.id}/decision`, { action: 'dismiss', note: 'ruido' });
    assert('dismiss → status dismissed', dis.status === 200 && dis.body.status === 'dismissed');

    out('\n▶ B5. Reaparición y resolución');
    const s4 = (await call('POST', '/scan')).body;
    const reopened = await sel("SELECT product_id, type FROM catalog_issues WHERE status = 'open' AND product_id IN (101, 106) AND source = 'scan'");
    assert('un scan no reabre lo decidido/descartado si el problema es el mismo', reopened.length === 0 && s4.created === 0, JSON.stringify({ s4, reopened }));
    await models.Product.update({ stock: 50 }, { where: { id: 106 } });
    await models.Product.update({ description: 'Texto corregido.' }, { where: { id: 102 } });
    const s5 = (await call('POST', '/scan')).body;
    const claimSt = (await sel("SELECT status, resolved_at FROM catalog_issues WHERE product_id = 102 AND type = 'unverified_claims'"))[0];
    assert('texto corregido → issue resuelto (status resolved)', s5.resolved >= 1 && claimSt.status === 'resolved' && claimSt.resolved_at, JSON.stringify(s5));
    await models.Product.update({ price: 2.99 }, { where: { id: 101 } });
    await call('POST', '/import', { rows: [{ id: 101, nombre: 'Mica', dropi_id: '18954', pvp: 2.99, coste: 0.75, stock: 619, flete: 5.54, fuente_flete: 'REAL', contrib_r15: -5, contrib_r30: -6, margen_r15_pct: -150, pvp_equilibrio_r30: 13.15, estado: '' }] });
    assert('si el problema cambia (otro PVP) se abre un issue nuevo pese a la decisión anterior',
      (await sel("SELECT count(*)::int n FROM catalog_issues WHERE product_id = 101 AND type = 'negative_margin' AND status = 'open'"))[0].n === 1);
    const all = (await call('GET', '/?status=all')).body;
    assert('?status=all incluye abiertos, decididos, descartados y resueltos', ['open', 'decided', 'dismissed', 'resolved'].every((s) => all.items.some((i) => i.status === s)));
    await models.Product.destroy({ where: { id: 104 } });
    assert('borrar un producto no falla (FK ON DELETE CASCADE)', true);

    if (process.env.CATALOG_HEALTH_CSV) await partBReal({ sel, models, call, hogar });
  } finally {
    server.close();
    await sequelize.close().catch(() => {});
  }
}

/** Análisis real (margenes.csv): los casos conocidos deben salir. */
async function partBReal({ sel, models, call }) {
  out('\n▶ B6. Seed con el análisis real');
  const { buildRows } = require('./catalog-health-seed');
  const rows = buildRows(process.env.CATALOG_HEALTH_CSV, process.env.CATALOG_HEALTH_EQUIV);
  const snap = process.env.CATALOG_HEALTH_PRODUCTS_JSON ? JSON.parse(fs.readFileSync(process.env.CATALOG_HEALTH_PRODUCTS_JSON, 'utf8')) : [];
  const desc = new Map(snap.map((p) => [p.id, p.description]));
  await sequelize().query('DELETE FROM catalog_issues');
  await models.Product.destroy({ where: {} });
  const cats = new Map();
  for (const r of rows) {
    const name = r.categoria || 'Sin categoría';
    if (!cats.has(name)) cats.set(name, (await models.Category.findOrCreate({ where: { name }, defaults: { image: 'x' } }))[0].id);
  }
  await models.Product.bulkCreate(rows.map((r) => ({
    id: Number(r.id), name: r.nombre, image: 'x', description: desc.get(Number(r.id)) || '', price: Number(r.pvp),
    costPrice: r.coste === '' ? null : Number(r.coste), stock: r.stock === '' ? null : Number(r.stock), showShop: true, isDeleted: false,
    categoryId: cats.get(r.categoria || 'Sin categoría'), sourceProvider: 'dropi', dropiProductId: r.dropi_id || null,
    dropiItems: r.dropi_id ? [{ id: r.dropi_id, qty: 1 }] : null,
  })));
  const imp = await call('POST', '/import', { rows });
  const sc = await call('POST', '/scan');
  out(`    import ${JSON.stringify({ ...imp.body, skipped: imp.body.skipped.length })} · scan ${JSON.stringify(sc.body)}`);
  const open = await sel("SELECT product_id, type, severity, details, suggestions FROM catalog_issues WHERE status = 'open'");
  const has = (pid, type) => open.find((r) => r.product_id === pid && r.type === type);
  const i82 = has(82, 'dropi_not_found');
  const swapIds = (r) => r.suggestions.filter((s) => s.action === 'swap_dropi_id').map((s) => s.params.dropiProductId);
  assert('82 / Dropi 81542 no existe (critical)', i82 && i82.details.dropiProductId === '81542' && i82.severity === 'critical');
  if (process.env.CATALOG_HEALTH_EQUIV) {
    assert('82 sugiere 185342 entre los candidatos', swapIds(i82).includes('185342'), swapIds(i82).join());
    assert('91 / 65636 no existe y sugiere 182227 y 175099', has(91, 'dropi_not_found') && ['182227', '175099'].every((x) => swapIds(has(91, 'dropi_not_found')).includes(x)));
  }
  const losing = { 81: 'hongo', 88: 'venda', 92: 'mica', 16: 'ligas', 85: 'V13', 46: 'Tower', 33: 'Alexa Pro Max', 80: 'cargador 139881' };
  for (const [pid, n] of Object.entries(losing)) assert(`negative_margin: ${n} (${pid})`, has(Number(pid), 'negative_margin'));
  if (snap.length) {
    for (const pid of [81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91]) assert(`unverified_claims en la ficha ${pid}`, has(pid, 'unverified_claims'));
  }
  const g = (await call('GET', '/')).body;
  const sample = { ...g, items: [g.items.find((i) => i.productId === 82 && i.type === 'dropi_not_found'), g.items.find((i) => i.productId === 81 && i.type === 'negative_margin')] };
  if (process.env.CATALOG_HEALTH_SAMPLE_OUT) fs.writeFileSync(process.env.CATALOG_HEALTH_SAMPLE_OUT, JSON.stringify(sample, null, 2));
  out(`    abiertos: ${JSON.stringify(g.summary)}`);
}
const sequelize = () => require('../libs/sequelize');

async function main() {
  const db = process.env.CATALOG_TEST_DATABASE_URL ? await setupDb() : null;
  if (!db) process.env.DATABASE_URL = 'postgres://cattest:test@localhost:5432/never_connects';
  try {
    await partA();
    if (db) await partB(db);
    else out('\n▶ Parte B (Postgres) OMITIDA: define CATALOG_TEST_DATABASE_URL (staging o local; nunca producción).');
  } finally {
    if (db) await dropSchema(db.raw, db.schema).catch((e) => console._error('no se pudo borrar el schema temporal:', e.message));
  }
  out(`\n${'─'.repeat(50)}\nCatalog health tests: ${passed} passed, ${failed} failed\n`);
  if (failed) { console._error('Logs capturados:\n' + logs.join('\n').slice(-6000)); process.exit(1); }
  process.exit(0);
}

main().catch((err) => { console._error('Error inesperado en la suite:', err); process.exit(1); });
