'use strict';
/* eslint-disable no-console */
/**
 * Proveedores alternativos (supplier_candidates) — test suite.
 *
 * Parte A (sin BD ni red): motor de texto/imagen/margen, clasificación, reglas del
 *   preferente, entrada (export de Dropi y CSV de equivalencias) y 401/403/400 del router.
 * Parte B (con CATALOG_TEST_DATABASE_URL): Postgres REAL en un schema temporal
 *   suppliers_test_<pid> que se borra al terminar (aborta con host roundhouse*).
 *   Migración up/down/up, refresh idempotente, contrato del GET, transiciones con
 *   auditoría, 422 con comprobaciones, un preferente por producto (también en carrera),
 *   vigilancia (degradación automática) y que el producto NUNCA cambia.
 *   Con SUPPLIER_EQUIV_CSV carga además el CSV real de equivalencias.
 *
 * Usage: [CATALOG_TEST_DATABASE_URL=postgres://…] node scripts/supplier-candidates-test.js
 */
const path = require('path');

Object.assign(process.env, { JWT_SECRET: 'test-jwt-secret-only', DROPI_MOCK: 'true' });

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

const NOW = Date.parse('2026-10-20T18:00:00Z');
const FRESH = '2026-10-20T12:00:00Z';
const STALE = '2026-10-10T12:00:00Z';
const FUENTE = { name: 'Fuente de agua para gatos comedero 2 en1', price: 29.99, costPrice: null };
const cand = (o) => ({ cost: 10, stock: 50, stockCheckedAt: FRESH, freight: 5.54, freightSource: 'REAL', supplierVerified: null, supplierPremium: null, ...o });

// ── Parte A ──────────────────────────────────────────────────────────────────
async function partA() {
  const s = require('../Services/supplierCandidateService');
  const { buildBody } = require('./supplier-candidates-refresh');

  out('\n▶ A1. Texto');
  assert('tokens: sin tildes/plurales/vacías, «2 en1» → 2en1, F-01 → f01, 30 kg → 30kg, x2',
    JSON.stringify(s.tokenize('Gafas de sol F-01 2 en1 30 kg Cámara x2')) === JSON.stringify(['gafa', 'sol', 'f01', '2en1', '30kg', 'camara', 'x2']), JSON.stringify(s.tokenize('Gafas de sol F-01 2 en1 30 kg Cámara x2')));
  assert('«De 10000» no se une como modelo (palabra vacía)', s.tokenize('Cigarrillos De Sabores De 10000 Legend').join() === 'cigarrillo,sabor,10000,legend', s.tokenize('Cigarrillos De Sabores De 10000 Legend').join());
  assert('sinónimos: comedor/comida → comedero; mascotas → mascota', s.tokenize('comedor comida mascotas').join() === 'comedero,comedero,mascota');
  const t1 = s.compareText(FUENTE.name, 'FUENTE DE AGUA Y COMEDOR  MASCOTA 2 EN 1');
  assert('176296: Jaccard 0.667, sin conflictos ni faltantes, sinónimo registrado', t1.score === 0.667 && !t1.conflicts.length && !t1.missing.length && t1.synonyms.includes('comedor→comedero'), JSON.stringify(t1));
  const t2 = s.compareText(FUENTE.name, 'Dispensador de agua para gatos');
  assert('185342: faltan tipo «fuente», «2 en 1» y comedero', t2.missing.length === 3 && t2.missing.some((m) => /fuente/.test(m)) && t2.missing.some((m) => /2 en 1/.test(m)) && t2.missing.some((m) => /comedero/.test(m)), JSON.stringify(t2.missing));
  const t3 = s.compareText('Kit De Pesas De 30kg Negras', 'Kit pesas 20 kg');
  assert('medida distinta (30kg vs 20kg) → conflicto', t3.conflicts.some((c) => /30kg ≠ 20kg/.test(c)), JSON.stringify(t3.conflicts));
  assert('modelo distinto (XG89 vs F-01) → conflicto', s.compareText('Gafas de sol modelo XG89', 'GAFAS DE SOL MODELO F-01').conflicts.some((c) => /modelo xg89/.test(c)));
  assert('candidato 3 en 1 vs tienda 2 en 1 → conflicto', s.compareText('Barbera 2 en 1', 'Barbera Patillera 3 en 1').conflicts.length === 1);
  assert('marca y modelo idénticos detectados (Venum + tp2)', s.compareText('Protector bucal Venum TP2', 'PROTECTOR BUCAL VENUM TP2').sameBrandAndModel === true);
  assert('marca explícita del export manda', s.compareText('Silla gamer CH-25', 'Silla gamer CH-25', { storeBrand: 'Marvo', candBrand: 'Otra' }).conflicts.some((c) => /marca marvo/.test(c)));

  out('\n▶ A2. Imagen');
  assert('sin hash → sin_comparar con motivo', s.compareImage(null, 'ffffffffffffffff').status === 'sin_comparar' && /tienda/.test(s.compareImage(null, 'ffffffffffffffff').reason));
  assert('hash inválido → sin_comparar', s.compareImage('xyz', 'ffffffffffffffff').status === 'sin_comparar');
  assert('Hamming 4 → casi_identica', s.compareImage('ffffffffffffffff', 'fffffffffffffff0').distance === 4 && s.compareImage('ffffffffffffffff', 'fffffffffffffff0').status === 'casi_identica');
  assert('Hamming 12 → parecida; 32 → distinta', s.compareImage('ffffffffffffffff', 'fffffffffffff000').status === 'parecida' && s.compareImage('ffffffffffffffff', 'ffffffff00000000').status === 'distinta');

  out('\n▶ A3. Margen y stock');
  const m = s.marginFor(29.99, 16, 5.54);
  assert('123170 a PVP 29.99, flete 5.54: r15 = 1.44, r30 = −0.78 (= fórmula de margenes.md)', m.r15.contribution === 1.44 && m.r30.contribution === -0.78, JSON.stringify(m));
  assert('PVP de equilibrio r30 calculado (31.32)', m.r30.breakEvenPvp === 31.32, String(m.r30.breakEvenPvp));
  const mr = s.marginFor(10, 2.99, 5.19);
  assert('parlante hongo (margenes.csv): r15 −1.38, r30 −2.97 (±0.01 de redondeo)', Math.abs(mr.r15.contribution + 1.38) <= 0.011 && Math.abs(mr.r30.contribution + 2.97) <= 0.011, JSON.stringify(mr));
  const ma = s.marginFor(29.99, 16, null);
  assert('sin flete → rango supuesto 5.10–7.96 (peor y mejor caso)', Array.isArray(ma.freight) && ma.r30.contribution < ma.r30.contributionBest);
  assert('sin coste → margen incompleto', s.marginFor(29.99, null, 5).incomplete === true);
  assert('stock: fresco > 5 confirmado; ≤ 5 bajo; 0 agotado; viejo sin_confirmar; null sin_datos',
    s.stockStatus(50, FRESH, NOW).status === 'confirmado' && s.stockStatus(3, FRESH, NOW).status === 'bajo' && s.stockStatus(0, FRESH, NOW).status === 'agotado'
    && s.stockStatus(50, STALE, NOW).status === 'sin_confirmar' && s.stockStatus(null, FRESH, NOW).status === 'sin_datos' && s.stockStatus(50, null, NOW).status === 'sin_confirmar');

  out('\n▶ A4. Clasificación');
  const sc = (p, c) => s.scoreCandidate(p, cand(c), {}, NOW);
  assert('176296 sin imagen ni marca+modelo → SIMILAR (nunca EXACTO sin evidencia)', sc(FUENTE, { name: 'FUENTE DE AGUA Y COMEDOR  MASCOTA 2 EN 1' }).classification === 'SIMILAR');
  assert('185342 → DISTINTO (faltan 3 atributos clave)', sc(FUENTE, { name: 'Dispensador de agua para gatos' }).classification === 'DISTINTO');
  assert('189358 plato → DISTINTO (texto < 0.3)', sc(FUENTE, { name: 'PLATO MASCOTA 2 EN 1 COMEDERO BEBEDERO' }).classification === 'DISTINTO');
  const ex = sc({ ...FUENTE, imageHash: 'ffffffffffffffff' }, { name: 'FUENTE DE AGUA Y COMEDOR  MASCOTA 2 EN 1', imageHash: 'fffffffffffffff0' });
  assert('atributos OK + imagen casi idéntica → EXACTO con motivo', ex.classification === 'EXACTO' && /casi idéntica/.test(ex.evidence.reasons.join()));
  assert('imagen distinta → DISTINTO aunque el texto coincida', sc({ ...FUENTE, imageHash: 'ffffffffffffffff' }, { name: FUENTE.name, imageHash: '0000000000000000' }).classification === 'DISTINTO');
  assert('sin imagen + marca y modelo idénticos → EXACTO', sc({ name: 'Protector bucal Venum TP2', price: 20 }, { name: 'PROTECTOR BUCAL VENUM TP2' }).classification === 'EXACTO');
  assert('imagen casi idéntica pero falta un atributo → SIMILAR', sc({ ...FUENTE, imageHash: 'ffffffffffffffff' }, { name: 'Fuente de agua gatos comedero', imageHash: 'ffffffffffffffff' }).classification === 'SIMILAR');
  const ev = sc(FUENTE, { name: 'Dispensador de agua para gatos' });
  assert('evidencia: campos comparados, flete con fuente, puntuaciones de texto/imagen/precio/stock',
    ev.scores.text.shared.includes('agua') && ev.evidence.freightSource === 'REAL' && ev.scores.image.status === 'sin_comparar' && ev.scores.price.totalCost === 15.54 && ev.scores.stock.status === 'confirmado');
  assert('determinista: misma entrada → misma salida', JSON.stringify(sc(FUENTE, { name: 'x fuente' })) === JSON.stringify(sc(FUENTE, { name: 'x fuente' })));

  out('\n▶ A5. Reglas del preferente');
  const okRow = (o = {}) => {
    const r = s.scoreCandidate({ name: 'Protector bucal Venum TP2', price: 20, costPrice: 5 }, cand({ name: 'PROTECTOR BUCAL VENUM TP2', cost: 4, supplierVerified: true, ...o }), {}, NOW);
    return { ...r, supplierVerified: true, supplierPremium: null, ...o };
  };
  assert('idéntico + verificado + stock fresco + coste ≤ actual → apto', s.preferredChecks(okRow()).ok === true, JSON.stringify(s.preferredChecks(okRow()).checks));
  const failsOn = (o, check) => { const c = s.preferredChecks(okRow(o)); return !c.ok && c.checks.find((x) => x.check === check)?.ok === false; };
  assert('proveedor sin datos (null) → no apto, «sin datos»', failsOn({ supplierVerified: null }, 'proveedor_confiable')
    && /sin datos/.test(s.preferredChecks(okRow({ supplierVerified: null })).checks.find((x) => x.check === 'proveedor_confiable').detail));
  assert('premium = true también vale como confiable', s.preferredChecks(okRow({ supplierVerified: null, supplierPremium: true })).ok === true);
  assert('stock viejo → no apto', failsOn({ stockCheckedAt: STALE }, 'disponibilidad_confirmada'));
  assert('stock 0 → no apto', failsOn({ stock: 0 }, 'disponibilidad_confirmada'));
  assert('coste total mayor → no apto', failsOn({ cost: 6 }, 'coste_total_igual_o_menor'));
  const noBase = s.scoreCandidate({ ...FUENTE }, cand({ name: FUENTE.name, supplierVerified: true }), {}, NOW);
  assert('sin coste de referencia (82) → no apto, con motivo', !s.preferredChecks({ ...noBase, supplierVerified: true }).ok
    && /sin coste de referencia/.test(s.preferredChecks({ ...noBase, supplierVerified: true }).checks.find((x) => x.check === 'coste_total_igual_o_menor').detail));
  assert('SIMILAR → no apto (articulo_identico)', !s.preferredChecks({ ...okRow(), classification: 'SIMILAR' }).ok);

  out('\n▶ A6. Entrada');
  const vs = s.fromDropi({ id: 9, name: 'Guantes Venum', sale_price: 15.5, stock: 0, supplier_id: 1, gallery: [{ urlS3: 'ecuador/products/9/a.jpg' }],
    variations: [{ id: 91, stock: 40, sale_price: 15.5, attributes: [{ name: 'talla', value: '12oz' }] }, { id: 92, stock: 0, attributes: [] }] }, { stockCheckedAt: FRESH });
  assert('export con variantes → un candidato por variante con su stock', vs.length === 2 && vs[0].dropiVariationId === '91' && vs[0].stock === 40 && /12oz/.test(vs[0].name));
  assert('urlS3 relativo → URL del CDN; verificado/premium ausentes → null (sin datos)',
    vs[0].imageUrl === 'https://d39ru7awumhhs2.cloudfront.net/ecuador/products/9/a.jpg' && vs[0].supplierVerified === null && vs[0].supplierPremium === null);
  assert('flags del proveedor solo si vienen de Dropi', s.fromDropi({ id: 1, name: 'x', supplier: { id: 5, name: 'Prov', verified: true, premium: 'si' } })[0].supplierVerified === true
    && s.fromDropi({ id: 1, name: 'x', supplier: { premium: 'si' } })[0].supplierPremium === null);
  const fx = path.join(__dirname, '../test/fixtures/dropi-export-82.json');
  const b82 = buildBody(['--dropi-json', fx], s);
  const c82 = b82.products[0].candidates;
  assert('fixture 82: 4 candidatos, flete 5.54 con fuente, fecha de stock propia del 189358', c82.length === 4 && c82.every((c) => c.freight === 5.54 && /ESTIMADO/.test(c.freightSource))
    && c82.find((c) => c.dropiProductId === '189358').stockCheckedAt === '2026-10-19T15:54:00Z' && b82.products[0].currentFreight === 5.54);
  const fresh = buildBody(['--dropi-json', path.join(__dirname, '../test/fixtures/dropi-export-82-fresh.json'), '--checked-at', FRESH], s).products[0];
  const P82 = { ...FUENTE, imageHash: fresh.storeImageHash };
  const scored = fresh.candidates.map((c) => ({ c, r: s.scoreCandidate(P82, c, {}, NOW) }));
  assert('export real del 82 (17:40Z) con dHash: 7 filas (174539 variable → 2 colores), imagen comparada en todas',
    scored.length === 7 && scored.filter(({ c }) => c.dropiProductId === '174539').length === 2 && scored.every(({ r }) => r.scores.image.status !== 'sin_comparar'));
  assert('export real del 82: ninguno EXACTO; 123170/176296 pasan a DISTINTO por imagen (Hamming 26/36)', scored.every(({ r }) => r.classification === 'DISTINTO')
    && scored.find(({ c }) => c.dropiProductId === '123170').r.scores.image.distance === 26);
  assert('el body del fixture pasa el esquema del refresh', !s.refreshSchema.validate(b82, { allowUnknown: true }).error);
  if (process.env.SUPPLIER_EQUIV_CSV) {
    const be = buildBody(['--equivalencias', process.env.SUPPLIER_EQUIV_CSV], s);
    assert('CSV real: 65 candidatos para 22 productos, stock sin fecha → sin confirmar', be.products.length === 22 && be.products.reduce((n, p) => n + p.candidates.length, 0) === 65
      && be.products.every((p) => p.candidates.every((c) => c.stockCheckedAt === null)));
  }
  assert('status inválido rechazado por el esquema', Boolean(s.statusSchema.validate({ status: 'aplicado' }).error));

  out('\n▶ A7. Router: autorización y validación');
  const { server, call } = await startApp();
  try {
    assert('sin token → 401', (await call('GET', '/supplier-candidates', null, null)).status === 401);
    assert('customer → 403', (await call('GET', '/supplier-candidates', null, tok('customer'))).status === 403);
    assert('POST status sin token → 401', (await call('POST', '/supplier-candidates/1/status', { status: 'descartado' }, null)).status === 401);
    assert('admin con status inválido → 400', (await call('POST', '/supplier-candidates/1/status', { status: 'aplicado' })).status === 400);
    assert('admin con id no numérico → 400', (await call('POST', '/supplier-candidates/abc/status', { status: 'descartado' })).status === 400);
    assert('admin con productId inválido → 400', (await call('GET', '/supplier-candidates?productId=-1')).status === 400);
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
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/catalog-health`;
  const admin = tok('admin', 7);
  const call = async (method, p, body, t = admin) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { server, call };
}

// ── Parte B ──────────────────────────────────────────────────────────────────
async function setupDb() {
  const raw = process.env.CATALOG_TEST_DATABASE_URL;
  const host = new URL(raw).hostname;
  if (/^roundhouse/i.test(host)) { console._error('ABORT: el host parece PRODUCCIÓN'); process.exit(2); }
  if (!/^(altaria|localhost$|127\.0\.0\.1$)/.test(host)) { console._error('ABORT: host no reconocido como staging/local'); process.exit(2); }
  const schema = `suppliers_test_${process.pid}`;
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
  const [{ n }] = (await c.query('SELECT count(*)::int n FROM information_schema.schemata WHERE schema_name = $1', [schema])).rows;
  await c.end();
  return n;
}

async function partB({ schema }) {
  const sequelize = require('../libs/sequelize');
  sequelize.options.logging = false;
  const { QueryTypes } = require('sequelize');
  const qi = sequelize.getQueryInterface();
  const { models } = sequelize;
  const sel = (sql, r = {}) => sequelize.query(sql, { replacements: r, type: QueryTypes.SELECT });
  const mig = require('../db/migrations/20261020000005-create-supplier-candidates');
  const { ProductSchema } = require('../db/models/productModel');
  const { CategorySchema } = require('../db/models/categoryModel');
  const svc = require('../Services/supplierCandidateService');
  const { buildBody } = require('./supplier-candidates-refresh');
  const { server, call } = await startApp();
  const BNOW = Date.now(); // setStatus re-evalúa con la hora real
  try {
    out(`\n▶ B0. Schema temporal ${schema} y migración`);
    const [{ sp }] = await sel('SELECT current_schema() AS sp');
    assert('conexión aislada en el schema temporal', sp === schema);
    const noRefs = (sch) => Object.fromEntries(Object.entries(sch).map(([k, v]) => { const { references, onUpdate, onDelete, ...rest } = v; return [k, rest]; })); // eslint-disable-line no-unused-vars
    await qi.createTable('categories', CategorySchema);
    await qi.createTable('products', noRefs(ProductSchema));
    await mig.up(qi);
    await mig.down(qi);
    const gone = (await sel("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = :s AND table_name = 'supplier_candidates'", { s: schema }))[0].n === 0;
    await mig.up(qi);
    await mig.up(qi);
    const idx = await sel("SELECT indexname FROM pg_indexes WHERE schemaname = :s AND tablename = 'supplier_candidates' ORDER BY 1", { s: schema });
    assert('migración up → down → up → up idempotente; índices único y un-preferente', gone && idx.some((i) => i.indexname === 'supplier_candidates_uniq') && idx.some((i) => i.indexname === 'supplier_candidates_one_preferred'));

    const [cat] = await models.Category.bulkCreate([{ name: 'Mascotas', image: 'x' }]);
    const P = (o) => ({ image: 'x', description: '', stock: 100, showShop: true, isDeleted: false, categoryId: cat.id, sourceProvider: 'dropi', ...o });
    await models.Product.bulkCreate([
      P({ id: 82, name: 'Fuente de agua para gatos comedero 2 en1', price: 29.99, dropiProductId: '81542', dropiItems: [{ id: '81542', qty: 1 }] }),
      P({ id: 91, name: 'Protector bucal Venum TP2', price: 20, costPrice: 5, dropiProductId: '65636', dropiItems: [{ id: '65636', qty: 1 }] }),
    ]);
    const snapshot = async () => JSON.stringify(await sel('SELECT id, price, cost_price, dropi_product_id, dropi_items, show_shop FROM products ORDER BY id'));
    const before = await snapshot();

    out('\n▶ B1. Refresh desde el export (fixture 82) y desde datos sintéticos');
    const fx = path.join(__dirname, '../test/fixtures/dropi-export-82.json');
    const r1 = await svc.refresh(buildBody(['--dropi-json', fx], svc), { now: BNOW });
    assert('fixture 82 → 4 creados', r1.created === 4 && r1.updated === 0, JSON.stringify(r1));
    const r2 = await svc.refresh(buildBody(['--dropi-json', fx], svc), { now: BNOW });
    assert('segundo refresh igual → 0 creados, 0 actualizados', r2.created === 0 && r2.updated === 0 && r2.unchanged === 4, JSON.stringify(r2));
    const [a, b] = await Promise.all([svc.refresh(buildBody(['--dropi-json', fx], svc), { now: BNOW }), svc.refresh(buildBody(['--dropi-json', fx], svc), { now: BNOW })]);
    const dup = await sel('SELECT count(*)::int n FROM supplier_candidates WHERE product_id = 82');
    assert('dos refresh concurrentes no duplican', a && b && dup[0].n === 4);
    const tp2 = (o = {}) => ({ source: 'dropi_export', products: [{ productId: 91, storeImageHash: null, currentFreight: 5.54, candidates: [
      { dropiProductId: '500', name: 'PROTECTOR BUCAL VENUM TP2', cost: 4, stock: 50, stockCheckedAt: new Date(BNOW - 3600e3).toISOString(), freight: 5.54, freightSource: 'REAL', supplierVerified: true, supplierPremium: null, ...o },
      { dropiProductId: '501', name: 'PROTECTOR BUCAL VENUM TP2', cost: 3.5, stock: 80, stockCheckedAt: new Date(BNOW - 3600e3).toISOString(), freight: 5.54, freightSource: 'REAL', supplierVerified: true, supplierPremium: null },
      { dropiProductId: '502', name: 'Protector bucal genérico', cost: 2, stock: 80, stockCheckedAt: new Date(BNOW - 3600e3).toISOString(), freight: 5.54, freightSource: 'REAL', supplierVerified: null, supplierPremium: null },
    ] }] });
    const r3 = await svc.refresh(tp2(), { now: BNOW });
    assert('producto inexistente → skipped (sin error)', (await svc.refresh({ source: 'dropi_export', products: [{ productId: 999, candidates: [] }] })).skipped[0].productId === 999);
    assert('3 candidatos del 91 creados', r3.created === 3, JSON.stringify(r3));

    out('\n▶ B2. GET (contrato para el panel)');
    const g = await call('GET', '/supplier-candidates?productId=82');
    const p82 = g.body.products?.[0];
    assert('GET 200 agrupado por producto con nombre, PVP y Dropi actual', g.status === 200 && g.body.products.length === 1 && p82.productId === 82 && p82.productPrice === 29.99 && p82.dropiProductId === '81542');
    assert('orden: SIMILAR antes que DISTINTO', p82.candidates[0].classification === 'SIMILAR' && p82.candidates.at(-1).classification === 'DISTINTO');
    const c0 = p82.candidates[0];
    assert('cada candidato trae coste, stock, flete+fuente, márgenes r15/r30, puntuaciones, evidencia, estado, historial y comprobaciones',
      ['cost', 'stock', 'freight', 'freightSource', 'margin', 'scores', 'evidence', 'status', 'history', 'preferredChecks', 'requiresCustomerAcceptance', 'classification', 'supplierVerified']
        .every((k) => k in c0) && c0.margin.r15 && c0.margin.r30 && c0.history.length === 1 && c0.requiresCustomerAcceptance === true, JSON.stringify(Object.keys(c0)));
    assert('verificado/premium = null (sin datos) en todos los del 82', p82.candidates.every((c) => c.supplierVerified === null && c.supplierPremium === null));
    assert('ningún candidato del 82 es apto para preferente', p82.candidates.every((c) => !c.preferredChecks.ok));
    assert('?status=descartado filtra', (await call('GET', '/supplier-candidates?status=descartado')).body.products.length === 0);

    out('\n▶ B3. Transiciones y auditoría');
    const id82 = c0.id;
    const prep82 = await call('POST', `/supplier-candidates/${id82}/status`, { status: 'preparado_preferente' });
    assert('preparar un SIMILAR → 422 con las comprobaciones que fallan', prep82.status === 422 && prep82.body.checks?.some((c) => c.check === 'articulo_identico' && !c.ok), JSON.stringify(prep82.body));
    const dis = await call('POST', `/supplier-candidates/${p82.candidates.at(-1).id}/status`, { status: 'descartado', note: 'no tiene comedero' });
    assert('descartar → 200, historial con quién/cuándo/nota', dis.status === 200 && dis.body.status === 'descartado' && dis.body.history.at(-1).by === 7 && dis.body.history.at(-1).note === 'no tiene comedero' && dis.body.history.at(-1).at);
    assert('descartado → preparado_preferente no permitido → 409', (await call('POST', `/supplier-candidates/${dis.body.id}/status`, { status: 'preparado_preferente' })).status === 409);
    assert('aprobado_por_propietario sin nota → 400', (await call('POST', `/supplier-candidates/${id82}/status`, { status: 'aprobado_por_propietario' })).status === 400);
    const apr = await call('POST', `/supplier-candidates/${id82}/status`, { status: 'aprobado_por_propietario', note: 'acepto como sustituto' });
    assert('aprobado SIMILAR → registra requiresCustomerAcceptance', apr.status === 200 && apr.body.history.at(-1).requiresCustomerAcceptance === true);
    assert('candidato inexistente → 404', (await call('POST', '/supplier-candidates/999999/status', { status: 'descartado' })).status === 404);

    const g91 = (await call('GET', '/supplier-candidates?productId=91')).body.products[0].candidates;
    const [e500, e501] = ['500', '501'].map((d) => g91.find((c) => c.dropiProductId === d));
    assert('91: 500 y 501 EXACTO (marca+modelo) y aptos', e500.classification === 'EXACTO' && e500.preferredChecks.ok && e501.preferredChecks.ok, JSON.stringify(e500.preferredChecks));
    assert('91: 502 genérico no apto (DISTINTO o SIMILAR, proveedor sin datos)', !g91.find((c) => c.dropiProductId === '502').preferredChecks.ok);
    const [x, y] = await Promise.all([
      call('POST', `/supplier-candidates/${e500.id}/status`, { status: 'preparado_preferente' }),
      call('POST', `/supplier-candidates/${e501.id}/status`, { status: 'preparado_preferente' }),
    ]);
    assert('dos «preparar» simultáneos del mismo producto: uno 200 y otro 409', [x.status, y.status].sort().join() === '200,409', `${x.status},${y.status}`);
    const winner = x.status === 200 ? x.body : y.body;
    assert('preparado con las comprobaciones en el historial', winner.status === 'preparado_preferente' && winner.history.at(-1).checks.every((c) => c.ok));
    const one = await sel("SELECT count(*)::int n FROM supplier_candidates WHERE product_id = 91 AND status = 'preparado_preferente'");
    assert('solo un preferente por producto', one[0].n === 1);

    out('\n▶ B4. Vigilancia: el preferente deja de cumplir');
    const wid = winner.dropiProductId;
    const body = tp2();
    body.products[0].candidates.find((c) => c.dropiProductId === wid).stock = 0;
    const r4 = await svc.refresh(body, { now: BNOW });
    const [w] = await sel('SELECT status, history FROM supplier_candidates WHERE id = :id', { id: winner.id });
    assert('stock 0 en el refresh → vuelve a propuesto con motivo auditado', r4.demoted === 1 && w.status === 'propuesto' && w.history.at(-1).by === 'refresh'
      && w.history.at(-1).checks.some((c) => c.check === 'disponibilidad_confirmada'), JSON.stringify(w.history.at(-1)));
    await models.Product.update({ costPrice: 1 }, { where: { id: 91 } });
    const loser = winner.id === e500.id ? e501 : e500;
    const cost = await call('POST', `/supplier-candidates/${loser.id}/status`, { status: 'preparado_preferente' });
    assert('coste actual del producto baja (1) → preparar re-evalúa y responde 422 por coste', cost.status === 422 && cost.body.checks.some((c) => c.check === 'coste_total_igual_o_menor' && !c.ok), JSON.stringify(cost.body));
    await models.Product.update({ costPrice: 5 }, { where: { id: 91 } });

    out('\n▶ B5. Nada toca el producto');
    const after = await snapshot();
    assert('products sin cambios salvo el costPrice que el test restauró (precio, Dropi, items, visibilidad)', before === after, `${before}\n${after}`);

    if (process.env.SUPPLIER_EQUIV_CSV) {
      out('\n▶ B6. CSV real de equivalencias');
      await models.Product.bulkCreate(buildBody(['--equivalencias', process.env.SUPPLIER_EQUIV_CSV], svc).products
        .filter((p) => ![82, 91].includes(p.productId)).map((p) => P({ id: p.productId, name: `Producto ${p.productId}`, price: 20 })));
      const rr = await svc.refresh(buildBody(['--equivalencias', process.env.SUPPLIER_EQUIV_CSV], svc), { now: BNOW });
      const n = await sel("SELECT count(*)::int n FROM supplier_candidates WHERE source = 'equivalencias_csv'");
      assert('CSV real importado sin errores (82 ya existía por el export)', rr.skipped.length === 0 && n[0].n >= 60, JSON.stringify(rr));
    }
  } finally {
    server.close();
    await sequelize.close().catch(() => {});
  }
}

async function main() {
  const db = process.env.CATALOG_TEST_DATABASE_URL ? await setupDb() : null;
  if (!db) process.env.DATABASE_URL = 'postgres://suptest:test@localhost:5432/never_connects';
  try {
    await partA();
    if (db) await partB(db);
    else out('\n▶ Parte B (Postgres) OMITIDA: define CATALOG_TEST_DATABASE_URL (staging o local; nunca producción).');
  } finally {
    if (db) {
      const left = await dropSchema(db.raw, db.schema).catch((e) => { console._error('no se pudo borrar el schema temporal:', e.message); return -1; });
      out(`\nschema temporal ${db.schema} borrado (restantes: ${left})`);
    }
  }
  out(`\n${'─'.repeat(50)}\nSupplier candidates tests: ${passed} passed, ${failed} failed\n`);
  if (failed) { console._error('Logs capturados:\n' + logs.join('\n').slice(-6000)); process.exit(1); }
  process.exit(0);
}

main().catch((err) => { console._error('Error inesperado en la suite:', err); process.exit(1); });
