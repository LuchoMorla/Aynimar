'use strict';
/* eslint-disable no-console */
/**
 * Servicios para invitados (sin BD ni red; modelos y LLM simulados):
 * - POST /orders/track/lookup {orderId, contact} → {trackingToken}: coincide (correo y
 *   teléfono normalizados), no coincide, sin enumeración (mismo 404/400), token generado
 *   si falta, límite por IP y por orderId, y que el contacto no aparece en los logs.
 * - POST /ai/nutria/chat con optionalAuth: el invitado sigue teniendo NutrIA; el Bearer
 *   identifica al usuario (su pedido sí, el ajeno no).
 * Usage: node scripts/track-lookup-test.js
 */

Object.assign(process.env, {
  DATABASE_URL: 'postgres://tltest:test@localhost:5432/tltest_never_connects',
  JWT_SECRET:   'test-jwt-secret-only',
});
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k.startsWith('GROQ_') || k === 'REDIS_URL') delete process.env[k];

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const TOKEN_101 = 'abcdefghijklmnopqrstuvwx';
const ORDERS = {
  101: { id: 101, state: 'comprada', stateOrder: 'x', trackingToken: TOKEN_101, customer: { userId: 2, phone: '0991234567', phoneTwo: null, user: { email: 'Ana@Cliente.ec' } } },
  102: { id: 102, state: 'pendiente_envio', stateOrder: 'x', trackingToken: null, customer: { userId: 3, phone: '+593 98 765 4321', phoneTwo: null, user: { email: 'b@x.ec' } } },
  103: { id: 103, state: 'carrito', stateOrder: 'x', trackingToken: null, customer: { userId: 4, phone: null, phoneTwo: null, user: { email: 'c@x.ec' } } },
};
const { models } = require('../libs/sequelize');
models.Order.findByPk = async (id) => (ORDERS[id] ? { ...ORDERS[id] } : null);
const updates = [];
models.Order.update = async (vals, { where }) => { updates.push({ vals, where }); return [1]; };
models.SalesPerformance.create = async () => ({});

const llmCalls = [];
let script = [];
const fakeLlm = { chat: { completions: { create: async (params) => {
  llmCalls.push(params.messages);
  const next = script.shift() || { content: 'ok' };
  return next.tools
    ? { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: next.tools.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }
    : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: next.content } }] };
} } } };

async function main() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  require('../utils/auth');
  const orderRouter = require('../routes/orderRouter');
  const aiRouter = require('../routes/aiRouter');
  aiRouter.llm = fakeLlm;
  const app = express();
  app.set('trust proxy', true); // X-Forwarded-For simula IPs distintas
  app.use(express.json());
  app.use('/api/v1/orders', orderRouter);
  app.use('/api/v1/ai', aiRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const lookup = async (ip, body) => {
    const r = await fetch(`${base}/orders/track/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.text() };
  };
  const tok = (sub, role) => jwt.sign({ sub, role }, process.env.JWT_SECRET);
  const chat = async (message, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`${base}/ai/nutria/chat`, { method: 'POST', headers, body: JSON.stringify({ message }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // Captura TODO lo que se escribe mientras corren las peticiones (logger incluido).
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const mute = () => {
    console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
    process.stdout.write = (c, ...r) => { logs.push(String(c)); return true; };
    process.stderr.write = (c, ...r) => { logs.push(String(c)); return true; };
  };
  const unmute = () => { console.log = orig.log; console.error = orig.error; console.warn = orig.warn; process.stdout.write = orig.out; process.stderr.write = orig.err; };

  try {
    mute();
    const r = {};
    r.email   = await lookup('10.0.0.1', { orderId: 101, contact: '  ana@cliente.EC ' });
    r.gen     = await lookup('10.0.0.1', { orderId: 102, contact: '0987654321' });
    r.wrong   = await lookup('10.0.0.1', { orderId: 101, contact: 'otro@x.ec' });
    r.missing = await lookup('10.0.0.1', { orderId: 999, contact: 'ana@cliente.ec' });
    r.cart    = await lookup('10.0.0.1', { orderId: 103, contact: 'c@x.ec' });
    r.ipLimit = await lookup('10.0.0.1', { orderId: 101, contact: 'ana@cliente.ec' });
    r.p593    = await lookup('10.0.0.2', { orderId: 101, contact: '593991234567' });
    r.pPlus   = await lookup('10.0.0.2', { orderId: 101, contact: '+593 99 123 4567' });
    r.pNo0    = await lookup('10.0.0.2', { orderId: 101, contact: '991234567' });
    r.orderLimit = await lookup('10.0.0.3', { orderId: 101, contact: 'ana@cliente.ec' });
    r.bad     = await lookup('10.0.0.3', { orderId: 'x', contact: 'a' });
    r.empty   = await lookup('10.0.0.3', {});
    unmute();

    console.log('\n▶ POST /orders/track/lookup');
    const NF = r.missing.body;
    assert('correo con mayúsculas/espacios coincide → 200 {trackingToken}', r.email.status === 200 && JSON.parse(r.email.body).trackingToken === TOKEN_101, r.email.body);
    assert('pedido sin token → se genera (24 car., base64url) y se guarda condicional', r.gen.status === 200 && /^[A-Za-z0-9_-]{24}$/.test(JSON.parse(r.gen.body).trackingToken)
      && updates.length === 1 && updates[0].where.id === 102 && updates[0].where.trackingToken === null, r.gen.body);
    assert('teléfono guardado con +593 y espacios coincide con 0XXXXXXXXX', r.gen.status === 200);
    assert('teléfono con 593, con +593 y sin 0 inicial coinciden', [r.p593, r.pPlus, r.pNo0].every((x) => x.status === 200 && JSON.parse(x.body).trackingToken === TOKEN_101), JSON.stringify([r.p593.status, r.pPlus.status, r.pNo0.status]));
    assert('contacto que no coincide → 404', r.wrong.status === 404);
    assert('sin enumeración: no coincide = no existe = carrito (mismo 404 y cuerpo)', r.missing.status === 404 && r.wrong.body === NF && r.cart.status === 404 && r.cart.body === NF, `${r.wrong.body} | ${r.cart.body}`);
    assert('cuerpo inválido → 400 con el mismo cuerpo genérico', r.bad.status === 400 && r.bad.body === NF && r.empty.status === 400 && r.empty.body === NF, r.bad.body);
    assert('6.º intento desde la misma IP → 429', r.ipLimit.status === 429, String(r.ipLimit.status));
    assert('6.º intento al mismo pedido desde otra IP → 429 (límite por orderId)', r.orderLimit.status === 429, String(r.orderLimit.status));
    const leaked = ['ana@cliente', 'otro@x.ec', '0987654321', '991234567', '765 4321'].filter((c) => logs.some((l) => l.toLowerCase().includes(c)));
    assert('el contacto no aparece en ningún log', leaked.length === 0, leaked.join(','));

    console.log('\n▶ POST /ai/nutria/chat (optionalAuth)');
    mute();
    script = [{ content: '¡Hola! Soy NutrIA.' }];
    const anon = await chat('hola');
    script = [{ content: 'Hola de nuevo.' }];
    const badTok = await chat('hola', 'basura');
    script = [{ tools: [['obtener_estado_orden', { orden_id: 101 }]] }, { content: 'Tu pedido va en camino.' }];
    await chat('¿y mi pedido 101?', tok(2, 'customer'));
    const ownCall = llmCalls.at(-1);
    script = [{ tools: [['obtener_estado_orden', { orden_id: 102 }]] }, { content: 'No lo encuentro.' }];
    await chat('¿y el pedido 102?', tok(2, 'customer'));
    const otherCall = llmCalls.at(-1);
    script = [{ tools: [['obtener_estado_orden', { orden_id: 101 }]] }, { content: 'No lo encuentro.' }];
    await chat('¿y mi pedido 101?');
    const anonCall = llmCalls.at(-1);
    unmute();
    const toolResult = (msgs) => msgs.find((m) => m.role === 'tool')?.content || '';
    assert('invitado sin Bearer → 200 con respuesta de NutrIA', anon.status === 200 && anon.json?.message === '¡Hola! Soy NutrIA.', JSON.stringify(anon.json));
    assert('Bearer inválido → sigue como anónimo (200)', badTok.status === 200 && badTok.json?.message === 'Hola de nuevo.');
    assert('Bearer del dueño → obtener_estado_orden devuelve su pedido', !/no encontrado/i.test(toolResult(ownCall)) && /101/.test(toolResult(ownCall)), toolResult(ownCall));
    assert('Bearer de otro cliente → «no encontrado»', /no encontrado/i.test(toolResult(otherCall)), toolResult(otherCall));
    assert('invitado → pedido «no encontrado» (sin fuga)', /no encontrado/i.test(toolResult(anonCall)), toolResult(anonCall));
  } finally {
    unmute();
    await new Promise((r) => { server.closeAllConnections(); server.close(r); });
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} track-lookup: ${passed} pasaron, ${failed} fallaron`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
