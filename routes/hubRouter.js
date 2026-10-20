'use strict';

// Entrada interna del hub WhatsApp multiempresa (ecosistema-luismorla/hub), inquilino AE.
//   POST /api/v1/hub/handle   { tenantId:'AE', origin, entry, phone, msgId, text?, replyId? }
//                             → { messages:[{type:'text',text}], handoff }
// Mismo patrón que Pulpia (Pescafast): reutiliza EXACTAMENTE el motor de NutrIA
// (aiRouter.runNutriaTurn) con channel='whatsapp' y las acciones de navegador
// (tarjetas, carrito, redirect) convertidas en texto con enlaces a la tienda
// (carrito/checkout ⇒ enlace /comprar, ver buyLink).
// Seguridad: FLAG_NUTRIA_HUB apagado o HUB_SHARED_SECRET sin configurar ⇒ 404.
// Firma: X-Hub-Signature = sha256=HMAC(HUB_SHARED_SECRET, `${X-Hub-Timestamp}.${body crudo}`),
// timestamp en segundos, ventana ±5 min, comparación timing-safe; la reproducción
// dentro de la ventana la frena el dedupe por msgId.
// Sesión SIEMPRE anónima: el hub no envía permisos ni JWT, así que
// obtener_estado_orden nunca devuelve pedidos (remite a la cuenta de la tienda).
// Privacidad: `phone` solo sirve de clave (HMAC con SUPPORT_PHONE_PEPPER, o HUB_SHARED_SECRET de respaldo) del historial en
// memoria; nunca se registra ni se manda al LLM. Los logs solo llevan origen y conteos.

const crypto = require('crypto');
const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const log = require('../libs/logger');
const ai = require('./aiRouter');

const router = express.Router();
const WINDOW_S = 5 * 60;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;
const MAX_TURNS_PER_HOUR = 30;

const enabled = () => process.env.FLAG_NUTRIA_HUB === 'true' && Boolean(process.env.HUB_SHARED_SECRET);

function verify(rawBody, tsHeader, sigHeader, secret = process.env.HUB_SHARED_SECRET, now = Date.now()) {
  if (!secret || !rawBody || !/^\d{10}$/.test(String(tsHeader || '')) || typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) return false;
  if (Math.abs(now / 1000 - Number(tsHeader)) > WINDOW_S) return false;
  const got = Buffer.from(sigHeader.slice(7), 'hex');
  const want = crypto.createHmac('sha256', secret).update(`${tsHeader}.`).update(rawBody).digest();
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const schema = Joi.object({
  tenantId: Joi.string().valid('AE').required(),
  origin: Joi.string().max(40).allow(null, ''),
  entry: Joi.boolean().default(false),
  phone: Joi.string().pattern(/^\d{8,15}$/).required(),
  msgId: Joi.string().max(120).required(),
  text: Joi.string().max(1000).allow(''),
  replyId: Joi.string().max(200).allow(null, ''),
  // Código [AE-PROD-<id>] (hub 9220516). Para Aynimar solo valen ids numéricos; el resto se ignora.
  product: Joi.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).allow(null, ''),
  machine: Joi.forbidden(), // AV (AyniMachine), no aplica a AE ⇒ 400
}).unknown(false);

// ponytail: sesiones y dedupe en memoria (una instancia; se pierden al reiniciar).
// Pasar a BD/Redis si se escala a varias réplicas.
const { models } = require('../libs/sequelize');
const sessions = new Map(); // HMAC(phone) → { history, contexto, ts, turns:[ms] }
const seen = new Map();     // msgId → ms
function sessionFor(phone, now) {
  // Pepper estable (compartido con AyniMachine): rotar HUB_SHARED_SECRET no pierde sesiones.
  const key = crypto.createHmac('sha256', process.env.SUPPORT_PHONE_PEPPER || process.env.HUB_SHARED_SECRET).update(`ae:${phone}`).digest('hex');
  let s = sessions.get(key);
  if (!s || now - s.ts > SESSION_TTL_MS) s = { history: [], contexto: {}, turns: [] };
  s.ts = now;
  sessions.delete(key); sessions.set(key, s); // orden de inserción = LRU
  for (const k of sessions.keys()) { if (sessions.size <= MAX_SESSIONS) break; sessions.delete(k); }
  return s;
}
function isDuplicate(msgId, now) {
  for (const [k, t] of seen) { if (now - t <= 2 * WINDOW_S * 1000) break; seen.delete(k); }
  if (seen.has(msgId)) return true;
  seen.set(msgId, now);
  return false;
}

// Enlace de compra (contrato con la tienda, rama feat/wa-buy-link):
//   ${NUTRIA_SHOP_URL}/comprar?items=<id>:<cant>[,<id>:<cant>...]&src=AE-WA
// Solo ids numéricos y cantidades 1–10 (más ⇒ 10; 0 o inválida ⇒ fuera), máx. 10 ítems.
// Sin precios, nombres, teléfonos ni tokens: la tienda recalcula precio y stock.
const MAX_BUY_ITEMS = 10;
const MAX_BUY_QTY = 10;
function buyLink(cart) {
  const items = Object.entries(cart || {})
    .filter(([id, qty]) => /^[1-9]\d{0,9}$/.test(String(id)) && Number.isInteger(Number(qty)) && Number(qty) >= 1)
    .slice(0, MAX_BUY_ITEMS)
    .map(([id, qty]) => `${id}:${Math.min(Number(qty), MAX_BUY_QTY)}`);
  if (!items.length) return null;
  const base = (process.env.NUTRIA_SHOP_URL || 'https://aynimar.com').replace(/\/$/, '');
  return `${base}/comprar?items=${items.join(',')}&src=AE-WA`;
}

// Respuesta web de NutrIA → mensajes de texto para WhatsApp. Tarjetas = enlace público a la
// ficha; carrito/checkout = enlace de compra con el carrito de la sesión (`cart`).
function toWhatsApp(body, cart) {
  const STORE = ai.STORE_URL;
  const out = [];
  if (body.message?.trim()) out.push(body.message.trim());
  const prods = (body.products || []).filter((p) => Number.isInteger(p.id)).slice(0, 3);
  if (prods.length) out.push(prods.map((p) => `• ${p.nombre} — $${p.precio}\n${STORE}/store/${p.id}`).join('\n\n'));
  const actions = body.actions || [];
  const wantsBuy = actions.some((a) => a.type === 'add_to_cart' || (a.type === 'redirect' && a.to === '/checkout'));
  const link = wantsBuy && buyLink(cart);
  if (link) out.push(`Para comprar, abre este enlace (precio y stock se confirman en la tienda): ${link}`);
  for (const a of actions) {
    if (a.type === 'redirect' && typeof a.to === 'string' && a.to.startsWith('/') && a.to !== '/checkout') out.push(`Aquí lo tienes: ${STORE}${a.to}`);
  }
  return [...new Set(out)].map((text) => ({ type: 'text', text }));
}

const badSignatureLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
});

router.post('/handle', (req, res, next) => (enabled() ? next() : res.sendStatus(404)), badSignatureLimiter, async (req, res) => {
  if (!verify(req.rawBody, req.get('x-hub-timestamp'), req.get('x-hub-signature'))) return res.sendStatus(401);
  const { value: b, error } = schema.validate(req.body);
  if (error) return res.status(400).json({ message: 'payload inválido' });

  const now = Date.now();
  if (isDuplicate(b.msgId, now)) return res.json({ messages: [], handoff: false });
  const s = sessionFor(b.phone, now);
  s.turns = s.turns.filter((t) => now - t < 60 * 60 * 1000);
  if (s.turns.length >= MAX_TURNS_PER_HOUR) {
    return res.json({ messages: [{ type: 'text', text: 'NutrIA 🦦: recibí muchos mensajes seguidos. Escríbeme de nuevo en un rato, porfa.' }], handoff: false });
  }
  s.turns.push(now);

  const groq = router.llm || ai.getGroqClient();
  if (!groq) return res.sendStatus(503);
  let message = b.text || 'hola'; // entrada sin texto (código, anuncio, menú) ⇒ saludo
  try {
    // Entrada con [AE-PROD-<id>]: ficha real primero (solo productos no eliminados) y el
    // motor la recibe en el contexto como "último producto mostrado".
    let ficha = null;
    if (b.entry && /^[1-9]\d{0,9}$/.test(b.product || '')) {
      const p = await models.Product.findOne({ where: { id: Number(b.product), isDeleted: false }, attributes: ['id', 'name', 'price'] });
      if (p) {
        ficha = { type: 'text', text: `• ${p.name} — $${p.price}\n${ai.STORE_URL}/store/${p.id}` };
        s.contexto.ultimosProductos = [{ id: p.id, nombre: p.name, precio: p.price }];
        if (!b.text) message = `Hola, me interesa el producto "${p.name}"`;
      }
    }
    const { body, toolCallNames } = await ai.runNutriaTurn(
      { message, history: s.history, contexto: s.contexto, sessionId: `hub-${now}`, channel: 'whatsapp' },
      groq,
    );
    s.history = [...s.history, { role: 'user', content: message }, { role: 'assistant', content: String(body.message || '') }].slice(-6);
    // El carrito se acumula entre turnos (el motor solo devuelve lo que cambió en este).
    const { estadoCarrito, ...rest } = body.estadoActualizado || {};
    Object.assign(s.contexto, rest);
    if (estadoCarrito) s.contexto.estadoCarrito = { ...s.contexto.estadoCarrito, ...estadoCarrito };
    const messages = [...(ficha ? [ficha] : []), ...toWhatsApp(body, s.contexto.estadoCarrito)];
    const handoff = toolCallNames.includes('alertar_telegram') || /\b(humano|asesor|persona)\b/i.test(b.text || '');
    log.info('hub_handle', { origin: b.origin || null, count: messages.length, handoff });
    return res.json({ messages, handoff });
  } catch (err) {
    log.error('hub_handle', { ok: false, error: err.message });
    return res.sendStatus(500);
  }
});

module.exports = router;
module.exports.verify = verify;
module.exports.toWhatsApp = toWhatsApp;
module.exports.buyLink = buyLink;
module.exports._sessions = sessions; // tests
