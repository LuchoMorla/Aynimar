'use strict';
/* eslint-disable no-console */
/**
 * Carga o refresca los candidatos de proveedor (supplier_candidates) desde datos de
 * Dropi YA EXPORTADOS. No llama a Dropi: los datos llegan del conector MCP de solo
 * lectura (list_products), que se ejecuta aparte y se guarda como JSON.
 *
 * Usage:
 *   node scripts/supplier-candidates-refresh.js (--equivalencias <csv> | --dropi-json <json>)
 *        [--margenes <margenes.csv>] [--checked-at <ISO>] [--product <id>] [--dry-run --products <snapshot.json>]
 *
 *   --equivalencias  informes/equivalencias-dropi.csv (65 candidatos, revisión manual del 20-oct).
 *   --dropi-json     { exportedAt, products: [{ productId, storeImageHash?, storeBrand?, freight?: {value, source},
 *                      items: [<producto crudo de list_products>] }] }  (ver docs/SUPPLIER_CANDIDATES.md)
 *   --margenes       flete por producto (columnas flete/fuente_flete) si el candidato no trae el suyo.
 *   --checked-at     fecha del dato de stock (por defecto exportedAt del JSON; el CSV no la trae → sin confirmar).
 *   --product        limita a un producto.
 *   --dry-run        sin BD: puntúa con --products (snapshot con id, name, price, costPrice) e imprime JSON.
 * Usa DATABASE_URL. Aborta si el host parece producción.
 */
const fs = require('fs');
const { parseCsv } = require('./catalog-health-seed');

function arg(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

function buildBody(args, svc) {
  const equiv = arg(args, '--equivalencias');
  const json = arg(args, '--dropi-json');
  if (!equiv === !json) throw new Error('usa --equivalencias <csv> o --dropi-json <json> (uno de los dos)');
  const only = arg(args, '--product') ? Number(arg(args, '--product')) : null;
  const freightBy = new Map();
  if (arg(args, '--margenes')) {
    for (const r of parseCsv(fs.readFileSync(arg(args, '--margenes'), 'utf8'))) {
      if (r.flete !== '') freightBy.set(Number(r.id), { value: Number(r.flete), source: r.fuente_flete || 'margenes.csv' });
    }
  }
  const groups = new Map();
  const add = (productId, extra, cands) => {
    if (only && productId !== only) return;
    const g = groups.get(productId) || { productId, candidates: [], ...extra };
    const f = extra.freight || freightBy.get(productId);
    for (const c of cands) {
      if (c.freight === null && f) Object.assign(c, { freight: f.value, freightSource: f.source });
      g.candidates.push(c);
    }
    groups.set(productId, g);
  };

  if (equiv) {
    const checkedAt = arg(args, '--checked-at');
    for (const r of parseCsv(fs.readFileSync(equiv, 'utf8'))) {
      if (!/^\d+$/.test(r.candidato_id || '')) continue;
      add(Number(r.product_id), {}, [svc.fromEquivalenceRow(r, { stockCheckedAt: checkedAt })]);
    }
    return { source: 'equivalencias_csv', products: [...groups.values()] };
  }
  const data = JSON.parse(fs.readFileSync(json, 'utf8'));
  const checkedAt = arg(args, '--checked-at') || data.exportedAt || null;
  for (const p of data.products || []) {
    const extra = { storeImageHash: p.storeImageHash || null, storeBrand: p.storeBrand || null, freight: p.freight || null };
    add(Number(p.productId), extra, (p.items || []).flatMap((raw) => svc.fromDropi(raw, { stockCheckedAt: checkedAt })));
  }
  for (const g of groups.values()) { g.currentFreight = g.freight?.value ?? null; delete g.freight; }
  return { source: 'dropi_export', products: [...groups.values()] };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  if (dry) process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dry:run@localhost:1/never_connects';
  const svc = require('../Services/supplierCandidateService');
  const body = buildBody(args, svc);
  for (const g of body.products) delete g.freight;

  if (dry) {
    const snap = arg(args, '--products') ? JSON.parse(fs.readFileSync(arg(args, '--products'), 'utf8')) : [];
    const byId = new Map(snap.map((p) => [Number(p.id), p]));
    const out = body.products.map((g) => {
      const p = byId.get(g.productId);
      if (!p) return { productId: g.productId, error: 'producto no está en --products' };
      const product = { name: p.name, price: Number(p.price), costPrice: p.costPrice ?? null, brand: g.storeBrand, imageHash: g.storeImageHash };
      const candidates = g.candidates.map((c) => {
        const s = svc.scoreCandidate(product, c, { currentFreight: g.currentFreight ?? null });
        return { ...c, ...s, preferredChecks: svc.preferredChecks({ ...c, ...s }) };
      }).sort(svc.rank);
      return { productId: g.productId, productName: p.name, productPrice: Number(p.price), costPrice: p.costPrice ?? null, candidates };
    });
    console.log(JSON.stringify({ source: body.source, products: out }, null, 2));
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) { console.error('ABORT: falta DATABASE_URL'); process.exit(2); }
  if (/^roundhouse/i.test(new URL(process.env.DATABASE_URL).hostname)) { console.error('ABORT: el host parece PRODUCCIÓN'); process.exit(2); }
  const sequelize = require('../libs/sequelize');
  sequelize.options.logging = false;
  try {
    console.log('refresh:', JSON.stringify(await svc.refresh(body)));
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) main().catch((err) => { console.error('refresh falló:', err.message); process.exit(1); });

module.exports = { buildBody };
