'use strict';
/* eslint-disable no-console */
/**
 * Aynimar Health Check
 *
 * Validates production readiness without starting the full Express server.
 * Connects to DB, checks token presence, validates critical env vars.
 *
 * Usage:
 *   node scripts/health-check.js
 *
 * Exit code 0 = healthy. Exit code 1 = one or more CRITICAL checks failed.
 * Exit code 2 = DEGRADED (warnings only, system can run).
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const checks = [];

function record(level, name, ok, detail = '') {
  checks.push({ level, name, ok, detail });
}

async function runChecks() {
  console.log('\n🔍 Aynimar Health Check\n');

  // ── DB connectivity ─────────────────────────────────────────────────────────
  try {
    const sequelize = require('../libs/sequelize');
    await sequelize.authenticate();
    record('CRITICAL', 'Database connection', true, 'PostgreSQL reachable');
    await sequelize.close();
  } catch (err) {
    record('CRITICAL', 'Database connection', false, err.message);
  }

  // ── Dropi session token in DB ───────────────────────────────────────────────
  try {
    const sequelize = require('../libs/sequelize');
    await sequelize.authenticate();
    const { models } = require('../libs/sequelize');
    const setting = await models.AppSetting.findOne({ where: { key: 'dropi_session_token' } });
    const hasToken = !!(setting?.value?.trim());
    record('CRITICAL', 'Dropi session token in DB', hasToken, hasToken ? 'Token present' : 'No token — catalog will be empty');
    await sequelize.close();
  } catch (err) {
    record('CRITICAL', 'Dropi session token in DB', false, err.message);
  }

  // ── Dropi order fulfillment token ───────────────────────────────────────────
  const orderToken = process.env.DROPI_ORDER_TOKEN || process.env.WOO_CONSUMER_SECRET;
  record('CRITICAL', 'DROPI_ORDER_TOKEN env var', !!orderToken, orderToken ? 'Configured' : 'Missing — orders cannot dispatch to Dropi');

  // ── AI copy key ─────────────────────────────────────────────────────────────
  const groqKey = process.env.GROQ_API_KEY || process.env.GROQ_IA_KEY;
  record('WARNING', 'GROQ_API_KEY env var', !!groqKey, groqKey ? 'Configured' : 'Missing — AI copy will be skipped on import');

  // ── Cloudflare Worker (optional but improves reliability) ──────────────────
  const workerUrl = process.env.DROPI_WORKER_URL;
  const workerKey = process.env.DROPI_WORKER_KEY;
  record('WARNING', 'Cloudflare Worker configured', !!(workerUrl && workerKey),
    (workerUrl && workerKey) ? 'Worker active (bypasses Railway WAF block)' : 'No Worker — direct Dropi calls may be blocked');

  // ── JWT secret ──────────────────────────────────────────────────────────────
  record('CRITICAL', 'JWT_SECRET env var', !!process.env.JWT_SECRET, process.env.JWT_SECRET ? 'Configured' : 'Missing — all authenticated routes will fail');

  // ── Print report ─────────────────────────────────────────────────────────────
  const criticalFails = checks.filter((c) => c.level === 'CRITICAL' && !c.ok);
  const warnings      = checks.filter((c) => c.level === 'WARNING'  && !c.ok);

  console.log('');
  for (const c of checks) {
    const icon   = c.ok ? '✅' : (c.level === 'CRITICAL' ? '🚨' : '⚠️ ');
    const badge  = c.ok ? '' : ` [${c.level}]`;
    console.log(`${icon} ${c.name}${badge}`);
    if (c.detail) console.log(`   └─ ${c.detail}`);
  }

  console.log(`\n${'─'.repeat(50)}`);

  if (criticalFails.length > 0) {
    console.error(`\n🚨 UNHEALTHY — ${criticalFails.length} critical check(s) failed:`);
    for (const c of criticalFails) console.error(`   • ${c.name}: ${c.detail}`);
    console.error('');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn(`\n⚠️  DEGRADED — ${warnings.length} warning(s) — system can run but some features are disabled`);
    process.exit(2);
  }

  console.log('\n✅ HEALTHY — All checks passed\n');
  process.exit(0);
}

runChecks().catch((err) => {
  console.error('Health check crashed:', err.message);
  process.exit(1);
});
