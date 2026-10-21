'use strict';
/* eslint-disable no-console */
/**
 * Entrada del hub WhatsApp (POST /api/v1/hub/handle, routes/hubRouter.js).
 * Sin BD ni red: LLM SIMULADO (nunca llama a Groq) y modelos Sequelize sustituidos.
 * Cubre: flag off 404, HMAC válido/inválido/timestamp vencido, sesión anónima
 * pidiendo un pedido → no encontrado (sin tocar BD), conversión a {messages}
 * con enlaces (ficha y /comprar con sus límites), handoff, dedupe y que el teléfono no aparezca en logs.
 * Usage: node scripts/hub-adapter-test.js
 */

const crypto = require('crypto');

Object.assign(process.env, {
  DATABASE_URL: 'postgres://hubtest:test@localhost:5432/hubtest_never_connects',
  JWT_SECRET:   'test-jwt-secret-only',
  HUB_SHARED_SECRET: 'secreto-hub-de-prueba-0123456789',
  NEXT_PUBLIC_FRONTEND_URL: 'https://tienda.test',
  NUTRIA_SHOP_URL: 'https://tienda-compra.test/',
});
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k.startsWith('GROQ_') || k === 'REDIS_URL' || k === 'SUPPORT_PHONE_PEPPER') delete process.env[k];
delete process.env.FLAG_NUTRIA_HUB;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const { models } = require('../libs/sequelize');
const orderLookups = [];
models.Order.findByPk = async (id) => { orderLookups.push(id); return { id, state: 'x', customer: { userId: 2 } }; };
const productFinds = [];
models.Product.findOne = async ({ where }) => { productFinds.push(where); return where.id === 42 && where.isDeleted === false ? { id: 42, name: 'Kit Solar Camping', price: 59.9 } : null; };
const productLists = [];
models.Product.findAll = async ({ where } = {}) => (productLists.push(where), [{ id: 5, name: 'Powerbank Solar 20000', price: 24.9, stock: 3, description: 'Carga', image: null }]);
models.SalesPerformance.create = async () => ({});

// LLM simulado: cada respuesta es la siguiente de `script`; registra los mensajes recibidos.
const llmCalls = [];
let script = [];
const fakeLlm = { chat: { completions: { create: async (params) => {
  llmCalls.push(JSON.parse(JSON.stringify(params.messages)));
  const next = script.shift() || { content: 'ok' };
  return next.tools
    ? { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: next.tools.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }
    : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: next.content } }] };
} } } };

const PHONE = '593987654321';
const sign = (raw, ts = Math.floor(Date.now() / 1000), secret = process.env.HUB_SHARED_SECRET) => ({
  'x-hub-timestamp': String(ts),
  'x-hub-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex'),
});
let n = 0;
const payload = (text, extra = {}) => ({ tenantId: 'AE', origin: 'WEB', entry: false, phone: PHONE, msgId: `wamid.t${++n}`, text, ...extra });

async function main() {
  const express = require('express');
  const hubRouter = require('../routes/hubRouter');
  hubRouter.llm = fakeLlm;
  const app = express();
  // Igual que index.js: rawBody solo para /api/v1/hub/.
  app.use(express.json({ verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/v1/hub/')) req.rawBody = Buffer.from(buf); } }));
  app.use('/api/v1/hub', hubRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/hub/handle`;
  const post = async (obj, headers) => {
    const raw = JSON.stringify(obj);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || sign(raw)) }, body: raw });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* no JSON */ }
    return { status: r.status, json };
  };

  // Captura logs para comprobar que el teléfono nunca se registra.
  const logs = [];
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  const capture = (orig) => (...a) => { logs.push(a.join(' ')); if (!String(a[0]).startsWith('{')) orig(...a); };
  console.log = capture(origLog); console.error = capture(origErr); console.warn = capture(origWarn);

  try {
    console.log('\n▶ Flag y firma');
    assert('flag apagado → 404 (incluso con firma válida)', (await post(payload('hola'))).status === 404);
    process.env.FLAG_NUTRIA_HUB = 'true';
    const tmp = process.env.HUB_SHARED_SECRET; delete process.env.HUB_SHARED_SECRET;
    assert('flag encendido sin HUB_SHARED_SECRET → 404', (await post(payload('hola'), { 'x-hub-timestamp': '1', 'x-hub-signature': 'sha256=00' })).status === 404);
    process.env.HUB_SHARED_SECRET = tmp;

    const p1 = payload('hola'); const raw1 = JSON.stringify(p1);
    assert('firma con otro secreto → 401', (await post(p1, sign(raw1, undefined, 'otro-secreto'))).status === 401);
    assert('sin firma → 401', (await post(p1, { 'x-hub-timestamp': String(Math.floor(Date.now() / 1000)) })).status === 401);
    assert('timestamp vencido (6 min) → 401', (await post(p1, sign(raw1, Math.floor(Date.now() / 1000) - 360))).status === 401);
    assert('body alterado tras firmar → 401', (await post({ ...p1, text: 'otro' }, sign(raw1))).status === 401);
    assert('tenantId ajeno → 400', (await post({ ...payload('hola'), tenantId: 'PF' })).status === 400);
    assert('llamadas al LLM hasta aquí: 0', llmCalls.length === 0);

    console.log('\n▶ Turno con LLM simulado → {messages}');
    script = [{ content: '¡Hola! Soy NutrIA 🦦, ¿qué buscas?' }];
    let r = await post(payload('', { entry: true }));
    assert('HMAC válido → 200', r.status === 200, String(r.status));
    assert('messages = [{type:text,text}] con el texto del motor', r.json?.messages?.[0]?.type === 'text' && /NutrIA/.test(r.json.messages[0].text), JSON.stringify(r.json));
    assert('handoff = false', r.json?.handoff === false);
    assert('entrada sin texto ⇒ "hola" al motor', llmCalls.at(-1).at(-1).content === 'hola');
    assert('system prompt incluye la nota de canal WhatsApp', /CANAL WHATSAPP/.test(llmCalls.at(-1)[0].content));
    assert('el teléfono no viaja al LLM', !JSON.stringify(llmCalls.at(-1)).includes(PHONE));

    console.log('\n▶ Sesión anónima pidiendo un pedido');
    script = [{ tools: [['obtener_estado_orden', { orden_id: 10 }]] }, { content: 'No lo encuentro por aquí.' }];
    r = await post(payload('dame el estado del pedido 10'));
    const toolMsg = llmCalls.at(-1).find((m) => m.role === 'tool');
    assert('200 con messages', r.status === 200 && Array.isArray(r.json?.messages));
    assert('herramienta → "no encontrado" y remite a la cuenta', /no encontrado/i.test(toolMsg?.content || '') && /mi_cuenta\/orders/.test(toolMsg.content), toolMsg?.content);
    assert('no se consultó la BD de pedidos', orderLookups.length === 0, String(orderLookups));
    assert('la historia previa viaja al motor (memoria por remitente)', llmCalls.at(-2).some((m) => m.role === 'assistant' && /qué buscas/.test(m.content || '')));

    console.log('\n▶ Acciones de navegador → texto con enlaces');
    script = [{ tools: [['buscar_producto', { nombre: 'powerbank' }]] }, { tools: [['agregar_al_carrito', { producto_id: 5, cantidad: 1 }], ['redirigir_checkout', {}]] }, { content: 'Te va a encantar.' }];
    r = await post(payload('quiero un powerbank'));
    const all = (r.json?.messages || []).map((m) => m.text).join('\n');
    assert('todos los mensajes son texto', r.json?.messages?.every((m) => m.type === 'text'));
    assert('ficha del producto con precio y enlace', /Powerbank Solar 20000 — \$24\.9\nhttps:\/\/tienda\.test\/store\/5/.test(all), all);
    assert('carrito/checkout → un solo enlace de compra', (all.match(/\/comprar\?/g) || []).length === 1, all);
    assert('enlace de compra = contrato', /https:\/\/tienda-compra\.test\/comprar\?items=5:1&src=AE-WA$/m.test(all), all);
    assert('sin tokens/JWT en los enlaces', !/token=|jwt|Bearer/i.test(all));
    script = [{ tools: [['agregar_al_carrito', { producto_id: 8, cantidad: 2 }]] }, { content: 'Listo.' }];
    r = await post(payload('agrega también el 8, dos'));
    const link2 = (r.json?.messages || []).map((m) => m.text).join('\n').match(/https:\S+comprar\S+/)?.[0];
    assert('el carrito se acumula entre turnos', link2 === 'https://tienda-compra.test/comprar?items=5:1,8:2&src=AE-WA', link2);
    assert('la URL de compra nunca lleva precio ni teléfono', link2 && !link2.includes('24.9') && !link2.includes(PHONE) && !/precio|price|\$/i.test(link2));

    console.log('\n▶ buyLink(): límites del contrato');
    const { buyLink } = hubRouter;
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i + 1), 1]));
    assert('11 ítems → recorta a 10', (buyLink(eleven).match(/items=([^&]+)/)[1].split(',')).length === 10);
    assert('cantidad 11 → 10', /items=3:10&/.test(buyLink({ 3: 11 })));
    assert('cantidad 0 → fuera (sin ítems ⇒ sin enlace)', buyLink({ 3: 0 }) === null);
    assert('cantidad no entera/negativa → fuera', buyLink({ 3: 1.5, 4: -2, 5: 'x' }) === null);
    assert('ids no numéricos o con inyección → fuera', buyLink({ abc: 1, '5;x': 1, '0': 1, '-3': 1, '1e3': 1, '7&src=evil': 1 }) === null);
    assert('ids válidos se conservan, inválidos se descartan', buyLink({ 12: 2, 'x': 1 }) === 'https://tienda-compra.test/comprar?items=12:2&src=AE-WA');
    const savedShop = process.env.NUTRIA_SHOP_URL; delete process.env.NUTRIA_SHOP_URL;
    assert('base por defecto https://aynimar.com', buyLink({ 1: 1 }) === 'https://aynimar.com/comprar?items=1:1&src=AE-WA');
    process.env.NUTRIA_SHOP_URL = savedShop;

    console.log('\n▶ Handoff y dedupe');
    script = [{ tools: [['alertar_telegram', { tipo: 'critico', mensaje: 'Reclamo <b>x</b>' }]] }, { content: 'Un humano te contactará.' }];
    const pd = payload('mi producto llegó roto');
    r = await post(pd);
    assert('alertar_telegram ⇒ handoff = true', r.json?.handoff === true, JSON.stringify(r.json));
    const before = llmCalls.length;
    r = await post(pd);
    assert('mismo msgId ⇒ sin mensajes ni LLM', r.status === 200 && r.json.messages.length === 0 && llmCalls.length === before);
    script = [{ content: 'Te paso con el equipo.' }];
    r = await post(payload('quiero hablar con un asesor'));
    assert('pedir asesor ⇒ handoff = true', r.json?.handoff === true);

    console.log('\n▶ Código [AE-PROD-<id>] (campo product)');
    assert('machine en el body → 400 (no aplica a AE)', (await post({ ...payload('hola'), machine: 'M-01' })).status === 400);
    assert('product con formato inválido → 400', (await post({ ...payload('hola'), product: '42;drop' })).status === 400);
    script = [{ content: '¡Ese kit es top!' }];
    r = await post(payload('', { entry: true, product: '42' }));
    assert('product numérico en la entrada → ficha primero con enlace', r.status === 200 && r.json.messages[0].text === 'Kit Solar Camping — $59.9\nhttps://tienda.test/store/42'.replace(/^/, '• '), JSON.stringify(r.json));
    assert('el motor recibe el producto (contexto y mensaje)', /Kit Solar Camping/.test(llmCalls.at(-1).at(-1).content) && /id:42/.test(llmCalls.at(-1)[0].content));
    assert('solo productos no eliminados', productFinds.at(-1).isDeleted === false && productFinds.at(-1).id === 42);
    assert('solo productos visibles en tienda (showShop)', productFinds.at(-1).showShop === true);
    const finds = productFinds.length;
    script = [{ content: 'Hola.' }];
    r = await post(payload('', { entry: true, product: 'SKU-ABC' }));
    assert('product no numérico → se ignora (200, sin consulta ni ficha)', r.status === 200 && productFinds.length === finds && !/store\//.test(r.json.messages.map((m) => m.text).join()));
    script = [{ content: 'Hola.' }];
    r = await post(payload('', { entry: true, product: '999' }));
    assert('product inexistente → sin ficha, sigue el saludo', r.status === 200 && r.json.messages.length === 1 && llmCalls.at(-1).at(-1).content === 'hola');

    console.log('\n▶ Catálogo filtrado (isDeleted / showShop)');
    script = [{ tools: [['get_detalles_producto', { producto_id: 42 }]] }, { content: 'Detalles.' }];
    await post(payload('detalles del 42'));
    assert('get_detalles_producto por WhatsApp: isDeleted:false y showShop:true', productFinds.at(-1).id === 42 && productFinds.at(-1).isDeleted === false && productFinds.at(-1).showShop === true, JSON.stringify(productFinds.at(-1)));
    script = [{ tools: [['buscar_producto', { nombre: 'linterna' }]] }, { content: 'Mira.' }];
    await post(payload('busco linterna'));
    assert('buscar_producto por WhatsApp: isDeleted:false y showShop:true', productLists.at(-1)?.isDeleted === false && productLists.at(-1)?.showShop === true);
    const { executeTool } = require('../routes/aiRouter');
    await executeTool('get_detalles_producto', { producto_id: 42 }, [], {}, {});
    assert('get_detalles_producto web: isDeleted:false (showShop sin cambios)', productFinds.at(-1).isDeleted === false && !('showShop' in productFinds.at(-1)));
    const nFinds = productFinds.length;
    const bad = await executeTool('get_detalles_producto', { producto_id: '1 OR 1=1' }, [], {}, {});
    assert('get_detalles_producto con id no numérico → error sin consulta', !!bad.error && productFinds.length === nFinds);

    console.log('\n▶ Privacidad');
    assert('el teléfono no aparece en ningún log', !logs.some((l) => l.includes(PHONE)), logs.find((l) => l.includes(PHONE)));
    assert('la clave de sesión no es el teléfono', ![...hubRouter._sessions.keys()].some((k) => k.includes(PHONE)));
    const keyWith = (secret) => crypto.createHmac('sha256', secret).update(`ae:${PHONE}`).digest('hex');
    assert('sin SUPPORT_PHONE_PEPPER: clave derivada de HUB_SHARED_SECRET (respaldo)', hubRouter._sessions.has(keyWith(process.env.HUB_SHARED_SECRET)));
    process.env.SUPPORT_PHONE_PEPPER = 'pepper-estable-de-prueba-0123456789';
    script = [{ content: 'Hola de nuevo.' }];
    await post(payload('hola otra vez'));
    assert('con SUPPORT_PHONE_PEPPER: clave derivada del pepper', hubRouter._sessions.has(keyWith(process.env.SUPPORT_PHONE_PEPPER)));
    const turnsBefore = llmCalls.length;
    process.env.HUB_SHARED_SECRET = 'secreto-hub-rotado-9876543210';
    script = [{ content: 'Sigo aquí.' }];
    await post(payload('¿sigues?'));
    assert('rotar HUB_SHARED_SECRET con pepper conserva la sesión (historial)', llmCalls.length === turnsBefore + 1 && llmCalls.at(-1).some((m) => m.role === 'assistant' && m.content === 'Hola de nuevo.'));
    assert('verify(): ventana ±5 min (futuro también)', !hubRouter.verify(Buffer.from('{}'), String(Math.floor(Date.now() / 1000) + 360), 'sha256=00'));
  } finally {
    console.log = origLog; console.error = origErr; console.warn = origWarn;
    await new Promise((r) => { server.closeAllConnections(); server.close(r); });
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} hub-adapter: ${passed} pasaron, ${failed} fallaron`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
