'use strict';
/* eslint-disable no-console */
/**
 * Informe de rentabilidad por producto activo — SOLO LECTURA.
 *
 * Lee products (show_shop y no borrados) de la BD de DATABASE_URL dentro de una
 * transacción READ ONLY, calcula contribución/margen con
 * Services/financeContribution.js y clasifica: rentable | no_rentable | incompleto.
 * No escribe en la BD, no llama a Dropi, no cambia precios.
 *
 * Usage:
 *   node scripts/finance-report.js [opciones]
 *     --target 0.30              margen objetivo sobre neto (default 0.30)
 *     --shipping 6 | 5.5:6.5     flete por pedido (valor conocido | rango de supuesto)
 *     --return-rate 0.3 | 0.2:0.4
 *     --return-cost 6 | 5:7
 *     --commission 0.02 | 0.01:0.03
 *     --delivery-rate 0.7        (si falta, se deriva de 1 − return-rate)
 *     --cost-includes-vat true|false   (si falta, se calculan ambos supuestos)
 *     --out <dir>                guarda JSON auditable con inputs, supuestos y resultados
 *     --send                     envía el resumen por utils/telegramNotify.js (por defecto solo imprime)
 *
 * Un dato que no se pasa NO se inventa: el producto queda "incompleto".
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const {
  contributionPerOrder, minProfitablePrice, classifyProfitability, pct,
} = require('../Services/financeContribution');

const TELEGRAM_LIMIT = 4000;
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "6" → {value:6}; "5.5:6.5" → {range:[5.5,6.5]}; undefined → {}. */
function parseNumberOrRange(name, raw) {
  if (raw === undefined) return {};
  const parts = String(raw).split(':').map(Number);
  if (!parts.every(Number.isFinite) || parts.length > 2) throw new Error(`--${name} inválido: ${raw}`);
  return parts.length === 1 ? { value: parts[0] } : { range: parts };
}

function buildInputs(opts) {
  const map = {
    shipping: 'shipping', 'return-rate': 'returnRate', 'return-cost': 'returnCost',
    commission: 'commissionRate', 'delivery-rate': 'deliveryRate',
  };
  const common = {};
  const assumptions = {};
  for (const [flag, field] of Object.entries(map)) {
    const p = parseNumberOrRange(flag, opts[flag]);
    common[field] = p.value ?? null;
    if (p.range) assumptions[field] = p.range;
  }
  const civ = opts['cost-includes-vat'];
  if (civ !== undefined && civ !== 'true' && civ !== 'false') throw new Error('--cost-includes-vat debe ser true|false');
  common.costIncludesVat = civ === undefined ? null : civ === 'true';
  return { common, assumptions };
}

function evaluateProduct(p, { common, assumptions }, targetMargin) {
  const pvp = Number(p.price);
  const cost = p.costPrice === null || p.costPrice === undefined ? null : Number(p.costPrice);
  const base = { id: p.id, name: p.name, pvp, cost };
  if (!Number.isFinite(pvp) || pvp <= 0) return { ...base, status: 'incompleto', reason: 'PVP inválido o 0' };
  // cost_price = 0 es dato sospechoso, no coste real (misma política que catalogPricingService.classifyCostPrice).
  if (cost !== null && !(cost > 0)) return { ...base, status: 'incompleto', reason: `cost_price sospechoso (${cost})` };

  const input = { ...common, pvp, qty: 1, cost, assumptions };
  const result = contributionPerOrder(input);
  const cls = classifyProfitability(result, targetMargin);
  const min = minProfitablePrice({ ...input, targetMargin });
  return { ...base, ...cls, result, minPvp: min.minPvp, minPvpRange: min.range };
}

/** Texto HTML para Telegram (≤ 4000). Solo id/nombre/PVP de catálogo: sin secretos ni datos de clientes. */
function buildTelegramSummary({ rows, targetMargin, assumptionsText, env }) {
  const by = { rentable: [], no_rentable: [], incompleto: [] };
  for (const r of rows) by[r.status].push(r);

  const head = [
    `<b>Informe de márgenes</b> (${escapeHtml(env)}) — objetivo ${pct(targetMargin)} sobre neto sin IVA`,
    `Activos: ${rows.length} · rentables ${by.rentable.length} · no rentables ${by.no_rentable.length} · incompletos ${by.incompleto.length}`,
    `Supuestos: ${escapeHtml(assumptionsText)}`,
  ];
  const lines = [...head];
  const tail = [];
  for (const [status, label] of [['no_rentable', '❌ No rentables'], ['rentable', '✅ Rentables'], ['incompleto', '⚠️ Incompletos']]) {
    if (!by[status].length) continue;
    lines.push('', `<b>${label}</b>`);
    by[status].forEach((r, i) => {
      const min = r.minPvp ? ` · PVP mín ${r.minPvp}` : '';
      const line = `#${r.id} ${escapeHtml(String(r.name).slice(0, 40))} — $${r.pvp}: ${escapeHtml(r.reason)}${min}`;
      const more = `… y ${by[status].length - i} más`;
      if (tail.length || lines.join('\n').length + line.length + more.length + 2 > TELEGRAM_LIMIT - 200) {
        if (!tail.includes(status)) { lines.push(more); tail.push(status); }
        return;
      }
      lines.push(line);
    });
  }
  let text = lines.join('\n');
  if (text.length > TELEGRAM_LIMIT) text = `${text.slice(0, TELEGRAM_LIMIT - 1)}…`;
  return text;
}

async function main() {
  const { values: opts } = parseArgs({
    options: {
      target: { type: 'string', default: '0.30' },
      shipping: { type: 'string' }, 'return-rate': { type: 'string' }, 'return-cost': { type: 'string' },
      commission: { type: 'string' }, 'delivery-rate': { type: 'string' }, 'cost-includes-vat': { type: 'string' },
      out: { type: 'string' }, send: { type: 'boolean', default: false },
    },
  });
  const targetMargin = Number(opts.target);
  if (!(targetMargin >= 0 && targetMargin < 1)) throw new Error('--target debe estar en [0,1)');
  const inputs = buildInputs(opts);

  require('dotenv').config();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL NO CONFIGURADO');
  const host = new URL(process.env.DATABASE_URL).hostname;
  const sequelize = require('../libs/sequelize');
  sequelize.options.logging = false;
  const { Op } = require('sequelize');

  let products;
  try {
    products = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
      return sequelize.models.Product.findAll({
        attributes: ['id', 'name', 'price', 'costPrice'],
        where: { showShop: true, isDeleted: { [Op.not]: true } },
        order: [['id', 'ASC']],
        raw: true,
        transaction,
      });
    });
  } finally {
    await sequelize.close();
  }

  const rows = products.map((p) => evaluateProduct(p, inputs, targetMargin));
  const assumptionsText = [
    ...Object.entries(inputs.common).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`),
    ...Object.entries(inputs.assumptions).map(([k, [a, b]]) => `${k}∈[${a},${b}]`),
  ].join(', ') || 'ninguno (datos faltantes → incompleto)';
  const env = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local';
  const summary = buildTelegramSummary({ rows, targetMargin, assumptionsText, env });

  console.log(`[finance-report] BD host: ${host} · ${rows.length} productos activos (lectura READ ONLY)\n`);
  console.log(summary);

  if (opts.out) {
    // ponytail: registro auditable en archivo JSON; la tabla de auditoría se añade cuando haya decisiones de precio persistentes.
    fs.mkdirSync(opts.out, { recursive: true });
    const generatedAt = new Date().toISOString();
    const file = path.join(opts.out, `finance-report-${generatedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ generatedAt, env, dbHost: host, targetMargin, inputs, rows }, null, 2));
    console.log(`\n[finance-report] JSON auditable: ${file}`);
  }

  if (opts.send) {
    const { sendTelegramNotification } = require('../utils/telegramNotify');
    await sendTelegramNotification(summary);
    console.log('[finance-report] resumen enviado a Telegram (si el bot está configurado y permitido)');
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('[finance-report] ERROR:', err.message); process.exit(1); });
}

module.exports = { buildTelegramSummary, evaluateProduct, buildInputs };
