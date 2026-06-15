'use strict';

const express  = require('express');
const passport = require('passport');
const OpenAI   = require('openai');
const { Op }   = require('sequelize');
const { checkRoles }          = require('../middlewares/authHandler');
const { optimizeProductCopy } = require('../integrations/aiCopyService');
const sequelize               = require('../libs/sequelize');

const router = express.Router();

// ── Groq client ───────────────────────────────────────────────────────────────
function getGroqClient() {
  const apiKey = process.env.GROQ_IA_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
}

// ── Telegram helper ───────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[NutrIA] Telegram no configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('[NutrIA] Telegram error:', err.message);
  }
}

// ── Rutas de navegación de la app ─────────────────────────────────────────────
const APP_ROUTES = {
  tienda:         '/store',
  checkout:       '/checkout',
  reciclaje:      '/recycling',
  contacto:       '/contact',
  login:          '/login',
  registro:       '/signInCustomer',
  mi_cuenta:      '/mi_cuenta',
  pedidos:        '/mi_cuenta/orders',
  como_funciona:  '/como-funciona',
  sobre_nosotros: '/aboutUs',
};

// ── Tool definitions ──────────────────────────────────────────────────────────
const NUTRIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_producto',
      description:
        'Busca productos disponibles en el inventario de Aynimar por nombre o descripción. ' +
        'Devuelve id, nombre, precio real y stock. Úsala SIEMPRE que el cliente pregunte por un producto.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre o descripción del producto' },
        },
        required: ['nombre'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obtener_estado_orden',
      description: 'Consulta el estado actual y número de guía de un pedido por su ID numérico.',
      parameters: {
        type: 'object',
        properties: {
          orden_id: { type: 'integer', description: 'ID numérico del pedido' },
        },
        required: ['orden_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agregar_al_carrito',
      description:
        'Agrega un producto al carrito del cliente. Úsala cuando el cliente confirme ' +
        'que quiere un producto específico.',
      parameters: {
        type: 'object',
        properties: {
          producto_id: { type: 'integer', description: 'ID del producto (obtenido de buscar_producto)' },
          cantidad:    { type: 'integer', description: 'Cantidad a agregar', minimum: 1 },
        },
        required: ['producto_id', 'cantidad'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'eliminar_del_carrito',
      description: 'Elimina o reduce la cantidad de un producto del carrito del cliente.',
      parameters: {
        type: 'object',
        properties: {
          producto_id: { type: 'integer', description: 'ID del producto a eliminar' },
          cantidad:    { type: 'integer', description: 'Cantidad a restar (0 = eliminar todo)', minimum: 0 },
        },
        required: ['producto_id', 'cantidad'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'redirigir_checkout',
      description:
        'Lleva al cliente directamente al checkout para finalizar su compra. ' +
        'Úsala cuando el cliente diga que quiere pagar, está listo o no encuentra el botón.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navegar_a',
      description:
        'Navega al cliente a cualquier sección de la app Aynimar. ' +
        'Úsala cuando pregunte cómo llegar a alguna parte o pida ir a una sección.',
      parameters: {
        type: 'object',
        properties: {
          destino: {
            type: 'string',
            enum: Object.keys(APP_ROUTES),
            description:
              'Destino: tienda, checkout, reciclaje, contacto, login, registro, ' +
              'mi_cuenta, pedidos, como_funciona, sobre_nosotros',
          },
        },
        required: ['destino'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alertar_telegram',
      description:
        'Envía alerta al equipo de Aynimar. ' +
        'tipo="oportunidad": cliente busca producto sin stock (recolecta nombre+teléfono+producto). ' +
        'tipo="critico": reclamo, reembolso o problema que requiere intervención humana.',
      parameters: {
        type: 'object',
        properties: {
          tipo:    { type: 'string', enum: ['oportunidad', 'critico'] },
          mensaje: { type: 'string', description: 'Mensaje completo con todos los datos del cliente' },
        },
        required: ['tipo', 'mensaje'],
      },
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────
const NUTRIA_SYSTEM_PROMPT = `Eres NutrIA, la nutria asistente autónoma de Aynimar — plataforma de e-commerce circular en Quito, Ecuador.

PERSONALIDAD: Carismática, empática y vendedora. Jerga ecuatoriana sutil ("¡De una!", "Ya le veo", "Chévere", "¿en qué te ayudo, ve?"). Respuestas cortas y directas. NUNCA menciones que eres una IA si no te preguntan.

REGLAS DE HERRAMIENTAS:
- Ante cualquier pregunta sobre precio o disponibilidad: usa buscar_producto() inmediatamente.
- Cliente listo para pagar / no encuentra el botón: usa redirigir_checkout() sin preguntar.
- Cliente quiere agregar: usa agregar_al_carrito() con el id devuelto por buscar_producto().
- Cliente no sabe cómo llegar a una sección: usa navegar_a() para llevarlo directo.
- Producto agotado o sin stock: di "¡Chuta, ese no lo tengo en este instante! Déjame tu nombre y WhatsApp y lo gestiono personalmente." Luego usa alertar_telegram(tipo="oportunidad").
- Reclamo grave / reembolso / problema complejo: usa alertar_telegram(tipo="critico") y avisa que un humano le contactará.
- Pedido del cliente: usa obtener_estado_orden() con el ID que proporcione.

CROSS-SELLING: Después de mostrar un producto, sugiere 1 complementario relacionado.
ANALÍTICA: Al finalizar, sé consciente de la emoción del cliente (no lo expreses, solo actúa en consecuencia).`;

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, clientActions) {
  const { models } = sequelize;

  if (name === 'buscar_producto') {
    try {
      const products = await models.Product.findAll({
        where: {
          name:      { [Op.iLike]: `%${args.nombre}%` },
          isDeleted: false,
          showShop:  true,
        },
        limit: 5,
        attributes: ['id', 'name', 'price', 'stock', 'description'],
      });
      if (products.length === 0) {
        return { encontrados: 0, productos: [], sinStock: true };
      }
      return {
        encontrados: products.length,
        productos: products.map((p) => ({
          id:          p.id,
          nombre:      p.name,
          precio:      p.price,
          stock:       p.stock ?? 'ilimitado',
          descripcion: (p.description || '').slice(0, 120),
        })),
      };
    } catch (err) {
      console.error('[NutrIA:buscar_producto]', err.message);
      return { error: 'No pude consultar el inventario ahora mismo.' };
    }
  }

  if (name === 'obtener_estado_orden') {
    try {
      const order = await models.Order.findByPk(args.orden_id, {
        attributes: ['id', 'state', 'stateOrder', 'createdAt', 'trackingNumber', 'carrierName'],
      });
      if (!order) return { error: 'Pedido no encontrado.' };
      return {
        id:            order.id,
        estado:        order.state,
        detalle:       order.stateOrder,
        guia:          order.trackingNumber ?? null,
        transportista: order.carrierName    ?? null,
        creado:        order.createdAt,
      };
    } catch (err) {
      console.error('[NutrIA:obtener_estado_orden]', err.message);
      return { error: 'No pude consultar el pedido.' };
    }
  }

  if (name === 'alertar_telegram') {
    const emoji  = args.tipo === 'critico' ? '⚠️' : '🚨';
    const titulo = args.tipo === 'critico' ? 'SOPORTE CRÍTICO' : 'OPORTUNIDAD DE VENTA';
    await sendTelegram(`${emoji} <b>${titulo}</b>\n\n${args.mensaje}`);
    return { enviado: true };
  }

  // ── Client-side actions (executed by the frontend) ────────────────────────
  if (name === 'agregar_al_carrito') {
    clientActions.push({ type: 'add_to_cart', productoId: args.producto_id, cantidad: args.cantidad });
    return { status: 'ok' };
  }

  if (name === 'eliminar_del_carrito') {
    clientActions.push({ type: 'remove_from_cart', productoId: args.producto_id, cantidad: args.cantidad });
    return { status: 'ok' };
  }

  if (name === 'redirigir_checkout') {
    clientActions.push({ type: 'redirect', to: '/checkout' });
    return { status: 'ok' };
  }

  if (name === 'navegar_a') {
    const ruta = APP_ROUTES[args.destino] ?? '/store';
    clientActions.push({ type: 'redirect', to: ruta });
    return { status: 'ok', ruta };
  }

  return { error: `Herramienta desconocida: ${name}` };
}

// ── POST /api/v1/ai/nutria/chat ───────────────────────────────────────────────
router.post('/nutria/chat', async (req, res, next) => {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ message: 'Se requiere el campo "message".' });
    }

    const groq = getGroqClient();
    if (!groq) {
      console.error('[NutrIA] GROQ_IA_KEY no configurada.');
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    const model = (process.env.GROQ_MODEL || 'llama-3.1-8b-instant').trim();

    const safeHistory = Array.isArray(history)
      ? history.filter(
          (m) =>
            m &&
            typeof m.role === 'string' &&
            typeof m.content === 'string' &&
            ['user', 'assistant'].includes(m.role)
        )
      : [];

    const messages = [
      { role: 'system', content: NUTRIA_SYSTEM_PROMPT },
      ...safeHistory,
      { role: 'user', content: message.trim() },
    ];

    const clientActions = [];
    const MAX_TOOL_ROUNDS = 5;
    let round = 0;

    console.log(`[NutrIA] → Groq  model="${model}"  msgs=${messages.length}`);

    let completion = await groq.chat.completions.create({
      model,
      messages,
      tools:       NUTRIA_TOOLS,
      tool_choice: 'auto',
    });
    let choice = completion.choices[0];

    while (choice.finish_reason === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      round++;
      messages.push(choice.message);

      const toolResults = await Promise.all(
        (choice.message.tool_calls || []).map(async (tc) => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (_) { /* ignore */ }
          console.log(`[NutrIA] tool(${round}): ${tc.function.name}(${JSON.stringify(args)})`);
          const result = await executeTool(tc.function.name, args, clientActions);
          return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
        })
      );

      messages.push(...toolResults);
      completion = await groq.chat.completions.create({
        model,
        messages,
        tools:       NUTRIA_TOOLS,
        tool_choice: 'auto',
      });
      choice = completion.choices[0];
    }

    const reply = choice.message?.content ?? '';
    console.log(`[NutrIA] ✓ reply=${reply.length}chars  actions=${clientActions.length}  rounds=${round}`);

    return res.json({ reply, actions: clientActions });
  } catch (err) {
    console.error('[NutrIA] Error inesperado:', err.message);
    next(err);
  }
});

// ── POST /api/v1/ai/nutria/session-close ─────────────────────────────────────
// Called by the frontend when the panel closes. Generates emotional analytics
// and sends a summary report to Telegram. Always returns 200 — non-fatal.
router.post('/nutria/session-close', async (req, res) => {
  try {
    const { history } = req.body;

    if (!Array.isArray(history) || history.length < 3) {
      return res.json({ ok: true });
    }

    const groq  = getGroqClient();
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!groq || !token || !chatId) {
      return res.json({ ok: true });
    }

    const model = (process.env.GROQ_MODEL || 'llama-3.1-8b-instant').trim();

    const safeHistory = history
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-12);

    const completion = await groq.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Analiza esta conversación de soporte de e-commerce. ' +
            'Responde ÚNICAMENTE con un JSON válido (sin markdown) con estas claves exactas: ' +
            'emocion_inicial (string), emocion_final (string), nivel_interes (1-10), ' +
            'productos_mencionados (array de strings), puntos_friccion (array de strings), ' +
            'resultado ("compro"|"abandono"|"pendiente"|"escalo_soporte").',
        },
        ...safeHistory,
        { role: 'user', content: 'Genera el análisis JSON de esta sesión.' },
      ],
    });

    let analysis = {};
    try {
      const raw   = completion.choices[0]?.message?.content ?? '{}';
      const match = raw.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(match ? match[0] : raw);
    } catch (_) { /* keep empty object */ }

    const msg =
      `📊 <b>Reporte de Sesión NutrIA</b>\n\n` +
      `😟 Emoción inicial: <b>${analysis.emocion_inicial ?? 'n/a'}</b>\n` +
      `😊 Emoción final: <b>${analysis.emocion_final ?? 'n/a'}</b>\n` +
      `⚡ Interés: <b>${analysis.nivel_interes ?? 'n/a'}/10</b>\n` +
      `🛍 Productos: ${(analysis.productos_mencionados ?? []).join(', ') || 'ninguno'}\n` +
      `🔧 Fricción: ${(analysis.puntos_friccion ?? []).join(', ') || 'ninguna'}\n` +
      `✅ Resultado: <b>${analysis.resultado ?? 'n/a'}</b>`;

    await sendTelegram(msg);
    return res.json({ ok: true, analysis });
  } catch (err) {
    console.error('[NutrIA:session-close]', err.message);
    return res.json({ ok: true });
  }
});

// ── POST /api/v1/ai/optimize-copy ────────────────────────────────────────────
router.post(
  '/optimize-copy',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res, next) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string' || text.trim().length < 5) {
        return res.status(400).json({ message: 'Body debe contener { text: "descripción del producto" }' });
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ message: 'ANTHROPIC_API_KEY no configurada en el servidor.' });
      }
      const optimized = await optimizeProductCopy(text.trim());
      if (!optimized) {
        return res.status(502).json({ message: 'La IA no pudo procesar el texto. Inténtalo de nuevo.' });
      }
      return res.json({ optimized });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
