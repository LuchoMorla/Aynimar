'use strict';
/* eslint-disable no-console */
/**
 * Carga local del análisis offline de márgenes en Salud del catálogo (= POST /import).
 *
 * Usage:
 *   node scripts/catalog-health-seed.js <margenes.csv> [--equivalencias <equivalencias.csv>] [--scan] [--dry-run]
 *
 *   --equivalencias  CSV de candidatos verificados (product_id,candidato_id,candidato_nombre,coste,stock,
 *                    proveedor,foto_url,confianza,evidencia) → sugerencias swap_dropi_id (nunca se aplican solas).
 *   --scan           después del import ejecuta también el scan de reglas sobre la BD.
 *   --dry-run        sin BD: valida el CSV y muestra los issues que generaría.
 * Usa DATABASE_URL. Aborta si el host parece producción.
 */
const fs = require('fs');

/** CSV RFC 4180 mínimo: comillas dobles, "" escapada, saltos de línea dentro de comillas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const CONF_RANK = { alta: 0, media: 1, baja: 2 };

/** Agrupa el CSV de equivalencias por product_id → alternativas (objetos candidato). */
function equivalencesByProduct(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!/^\d+$/.test(r.candidato_id || '')) continue; // "sin candidatos"
    const list = map.get(Number(r.product_id)) || [];
    list.push({
      id: r.candidato_id, name: r.candidato_nombre || null,
      cost: r.coste === '' ? null : Number(r.coste), stock: r.stock === '' ? null : parseInt(r.stock, 10),
      supplier: r.proveedor || null, imageUrl: r.foto_url || null, confidence: r.confianza || null, evidence: r.evidencia || null,
    });
    map.set(Number(r.product_id), list);
  }
  for (const list of map.values()) list.sort((a, b) => (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3));
  return map;
}

function buildRows(csvPath, equivPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (equivPath) {
    const eq = equivalencesByProduct(parseCsv(fs.readFileSync(equivPath, 'utf8')));
    for (const r of rows) if (eq.has(Number(r.id))) r.alternativas = eq.get(Number(r.id)).slice(0, 10);
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const csvPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--equivalencias');
  const equivPath = flag('--equivalencias') ? args[args.indexOf('--equivalencias') + 1] : null;
  if (!csvPath) { console.error('Uso: node scripts/catalog-health-seed.js <margenes.csv> [--equivalencias <csv>] [--scan] [--dry-run]'); process.exit(2); }
  const rows = buildRows(csvPath, equivPath);

  if (flag('--dry-run')) {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://dry:run@localhost:1/never_connects';
    const Joi = require('joi');
    const svc = require('../Services/catalogHealthService');
    const { rows: valid } = Joi.attempt({ rows }, svc.importSchema, { abortEarly: false, stripUnknown: true });
    const issues = valid.flatMap((r) => svc.detectRow(r, r.id, r.alternativas ? svc.parseAlternatives(r.alternativas) : []));
    for (const i of issues) console.log(`${i.productId}\t${i.severity}\t${i.type}\t${i.title}`);
    console.log(`\n${valid.length} filas válidas → ${issues.length} issues (dry-run, sin BD)`);
    process.exit(0);
  }

  const host = new URL(process.env.DATABASE_URL || 'postgres://x@missing/x').hostname;
  if (!process.env.DATABASE_URL) { console.error('ABORT: falta DATABASE_URL'); process.exit(2); }
  if (/^roundhouse/i.test(host)) { console.error('ABORT: el host parece PRODUCCIÓN'); process.exit(2); }

  const sequelize = require('../libs/sequelize');
  sequelize.options.logging = false;
  const svc = require('../Services/catalogHealthService');
  try {
    const imp = await svc.importRows({ rows });
    console.log('import:', JSON.stringify({ created: imp.created, updated: imp.updated, resolved: imp.resolved, skipped: imp.skipped.length }));
    for (const s of imp.skipped) console.log(`  omitida ${s.id}: ${s.reason}`);
    if (flag('--scan')) console.log('scan:', JSON.stringify(await svc.scan()));
    const { summary } = await svc.list('open');
    console.log('abiertos:', JSON.stringify(summary));
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) main().catch((err) => { console.error('seed falló:', err.message); process.exit(1); });

module.exports = { parseCsv, equivalencesByProduct, buildRows };
