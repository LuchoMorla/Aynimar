'use strict';
/* eslint-disable no-console */
/**
 * E2E hub multiempresa → NutrIA (2026-10-20). Levanta en proceso la entrada
 * POST /api/v1/hub/handle (routes/hubRouter.js) con LLM SIMULADO y sin BD, y el
 * hub local (ecosistema-luismorla/hub, HUB_DIR) con el adaptador `remote` del
 * inquilino AE apuntando a ella. Webhook de Meta simulado y firmado en el hub;
 * nada sale a Internet (el hub entrega al callback onOutbox).
 *
 *   HUB_DIR=~/ecosistema-luismorla/hub node test/hub-adapter-e2e.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const HUB_DIR = process.env.HUB_DIR || path.join(process.env.HOME, 'ecosistema-luismorla/hub');
const SHARED = crypto.randomBytes(24).toString('hex');
Object.assign(process.env, {
  DATABASE_URL: 'postgres://hubtest:test@localhost:5432/hubtest_never_connects',
  JWT_SECRET: 'test-jwt-secret-only',
  FLAG_NUTRIA_HUB: 'true',
  HUB_SHARED_SECRET: SHARED,
});
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k.startsWith('GROQ_') || k === 'REDIS_URL') delete process.env[k];

const { models } = require('../libs/sequelize');
const orderLookups = [];
models.Order.findByPk = async (id) => { orderLookups.push(id); return null; };
models.Product.findAll = async () => [{ id: 7, name: 'Linterna Solar LED', price: 12.5, stock: 4, description: 'Luz', image: null }];
models.SalesPerformance.create = async () => ({});

let script = [];
const fakeLlm = { chat: { completions: { create: async () => {
  const next = script.shift() || { content: 'ok' };
  return next.tools
    ? { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: next.tools.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }
    : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: next.content } }] };
} } } };

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); } catch (e) { fail += 1; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function main() {
  const express = require('express');
  const hubRouter = require('../routes/hubRouter');
  hubRouter.llm = fakeLlm;
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/v1/hub/')) req.rawBody = Buffer.from(buf); } }));
  app.use('/api/v1/hub', hubRouter);
  const api = app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));

  const { createServer } = require(path.join(HUB_DIR, 'src/server'));
  const { createHub } = require(path.join(HUB_DIR, 'src/hub'));
  const { loadTenants } = require(path.join(HUB_DIR, 'src/tenants'));
  const META = crypto.randomBytes(16).toString('hex');
  const env = {
    HUB_PEPPER: crypto.randomBytes(24).toString('hex'),
    WHATSAPP_APP_SECRET: META,
    HUB_TENANT_AE_URL: `http://127.0.0.1:${api.address().port}/api/v1/hub/handle`,
    HUB_TENANT_AE_SECRET: SHARED,
  };
  const outboxes = [];
  const hub = createServer({ env, hub: createHub({ env, registry: loadTenants(undefined, env) }), log: () => {}, onOutbox: (o) => outboxes.push(...o) });
  const hubPort = await listen(hub);

  const PHONE = `5939${String(Date.now()).slice(-8)}`;
  let n = 0;
  const say = async (text) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: PHONE, id: `wamid.e2e${++n}`, type: 'text', text: { body: text } }] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', META).update(raw).digest('hex');
    const before = outboxes.length;
    const res = await fetch(`http://127.0.0.1:${hubPort}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
    assert.strictEqual(res.status, 200);
    return outboxes.slice(before).flatMap((o) => o.messages || []).map((m) => m.text || m.body || JSON.stringify(m)).join('\n');
  };

  try {
    console.log('\n▶ Hub → NutrIA (remote AE, LLM simulado)');
    await check('código [AE-WEB] abre NutrIA real y el hub añade el aviso de canal compartido', async () => {
      script = [{ content: '¡Hola! Soy NutrIA 🦦, ¿qué necesitas?' }];
      const out = await say('hola [AE-WEB]');
      assert.match(out, /Soy NutrIA/, out);
      assert.match(out, /canal empresarial compartido/, out);
      assert.doesNotMatch(out, /disculpa, en este momento no puedo atenderte/, out);
    });
    await check('siguiente mensaje sigue en AE: producto → enlace a la ficha', async () => {
      script = [{ tools: [['buscar_producto', { nombre: 'linterna' }]] }, { content: 'Esta te salva.' }];
      const out = await say('busco una linterna');
      assert.match(out, /Linterna Solar LED — \$12\.5\nhttps:\/\/www\.aynimar\.com\/store\/7/, out);
    });
    await check('pedido por número (sesión anónima) → no se consulta la BD', async () => {
      script = [{ tools: [['obtener_estado_orden', { orden_id: 99 }]] }, { content: 'Por aquí no veo pedidos; revísalo en tu cuenta.' }];
      const out = await say('estado del pedido 99');
      assert.match(out, /tu cuenta/, out);
      assert.strictEqual(orderLookups.length, 0);
    });
  } finally {
    await new Promise((r) => { hub.closeAllConnections?.(); hub.close(r); });
    await new Promise((r) => { api.closeAllConnections(); api.close(r); });
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} hub-adapter-e2e: ${pass} pasaron, ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
