'use strict';
/* eslint-disable no-console */
/**
 * Aynimar Post-Deploy Remote Health Check
 *
 * Hits the production /health endpoint and sends a Telegram alert.
 * Run this from local after pushing to Railway to confirm deploy is alive.
 *
 * Usage:
 *   node scripts/post-deploy.js
 *   node scripts/post-deploy.js https://aynimar-production.up.railway.app
 *
 * Requires env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID (or TELEGRAM_CHAT_ID)
 * Exit code 0 = healthy. Exit code 1 = degraded or unreachable.
 */

const BASE_URL = process.argv[2] || process.env.BACKEND_URL || 'https://aynimar-production.up.railway.app';

async function run() {
  console.log(`\n🔍 Post-deploy check → ${BASE_URL}/health\n`);

  let data;
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(15_000) });
    data = await res.json();
  } catch (err) {
    console.error(`🚨 UNREACHABLE — ${err.message}`);
    await notify(`🚨 <b>POST-DEPLOY FAIL</b>\n\n${BASE_URL}\n\nServidor no responde: ${err.message}`);
    process.exit(1);
  }

  const icon   = data.status === 'ok' ? '✅' : '⚠️ ';
  const status = data.status?.toUpperCase() ?? 'UNKNOWN';

  console.log(`${icon} Status: ${status}`);
  console.log(`   uptime: ${data.uptime}s`);

  if (data.checks) {
    for (const [k, ok] of Object.entries(data.checks)) {
      console.log(`   ${ok ? '✅' : '🚨'} ${k}`);
    }
  }

  const failedKeys = data.checks
    ? Object.entries(data.checks).filter(([, ok]) => !ok).map(([k]) => k)
    : [];

  const msg =
    `${icon} <b>Post-Deploy: ${status}</b>\n\n` +
    `${BASE_URL}\n` +
    `Uptime: ${data.uptime}s\n\n` +
    (failedKeys.length > 0
      ? `🚨 Vars faltantes:\n${failedKeys.map((k) => `  • ${k}`).join('\n')}`
      : '✅ Todos los checks OK');

  await notify(msg);

  if (data.status !== 'ok') {
    process.exit(1);
  }
  console.log('\n✅ Deploy healthy.\n');
}

async function notify(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('   (Telegram not configured — skipping notification)');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    console.log('   📨 Telegram notificado.');
  } catch (err) {
    console.error('   Telegram error:', err.message);
  }
}

run().catch((err) => {
  console.error('post-deploy.js crashed:', err.message);
  process.exit(1);
});
