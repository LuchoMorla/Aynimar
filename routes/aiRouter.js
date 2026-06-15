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
    console.warn('[NutrIA] Telegram no configurado — define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID.');
    return false;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await resp.json();
    if (!data.ok) console.error('[NutrIA] Telegram API error:', JSON.stringify(data));
    return data.ok === true;
  } catch (err) {
    console.error('[NutrIA] Telegram fetch error:', err.message);
    return false;
  }
}

// ── Sanitize reply — strip leaked <function=…>…</function> artifacts ──────────
function sanitizeReply(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, '')
    .replace(/\[function=[^\]]*\]/gi, '')
    .replace(/^\s*\n+/, '')
    .trim();
}

// ── Build a compact narrative from the client's state manager ─────────────────
// The frontend sends a structured "contexto" object instead of a raw history
// array, keeping the model context window small and unambiguous.
function buildContextNarrative(contexto) {
  if (!contexto || typeof contexto !== 'object') return '';
  const lines = [];

  const { perfilCliente, historialIntereses, estadoCarrito, trackingSoporte } = contexto;

  if (perfilCliente) {
    if (perfilCliente.nombre) lines.push(`• Cliente: <b>${perfilCliente.nombre}</b>`);
    if (perfilCliente.telefono) lines.push(`• WhatsApp: ${perfilCliente.telefono}`);
  }

  if (Array.isArray(historialIntereses) && historialIntereses.length > 0) {
    lines.push(`• Productos de interés previos: ${historialIntereses.slice(-6).join(', ')}`);
  }

  if (estadoCarrito && typeof estadoCarrito === 'object') {
    const items = Object.entries(estadoCarrito)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => `id:${id} x${qty}`)
      .join(', ');
    if (items) lines.push(`• Carrito activo: ${items}`);
  }

  if (trackingSoporte?.ordenId) {
    lines.push(`• Pedido en seguimiento: #${trackingSoporte.ordenId}` +
      (trackingSoporte.estado ? ` (${trackingSoporte.estado})` : ''));
  }

  if (lines.length === 0) return '';
  return '\n\nCONTEXTO ACTIVO DEL CLIENTE:\n' + lines.join('\n');
}

// ── Try to extract nombre / telefono from an alertar_telegram message ─────────
function extractProfileFromMensaje(mensaje) {
  const nombreMatch   = mensaje.match(/(?:nombre|cliente)[:\s]+([A-Za-záéíóúÁÉÍÓÚñÑ\s]{2,40}?)(?:\n|,|\.|WhatsApp|teléfono|tel|\||$)/i);
  const telefonoMatch = mensaje.match(/(?:WhatsApp|teléfono|tel|celular|número)[:\s]+(\+?[\d\s\-().]{6,18})/i);
  return {
    nombre:   nombreMatch   ? nombreMatch[1].trim()   : null,
    telefono: telefonoMatch ? telefonoMatch[1].trim() : null,
  };
}

// ── App navigation map ────────────────────────────────────────────────────────
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
        'Busca productos en el inventario de Aynimar por nombre o descripción. ' +
        'Devuelve id, nombre, precio y stock reales. Úsala SIEMPRE que el cliente pregunte por un producto.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre o descripción del producto a buscar' },
        },
        required: ['nombre'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obtener_estado_orden',
      description: 'Consulta el estado y número de guía de un pedido dado su ID numérico.',
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
        'Agrega un producto al carrito del cliente. ' +
        'Usa el id exacto devuelto por buscar_producto. ' +
        'Úsala solo cuando el cliente confirme que quiere ese producto.',
      parameters: {
        type: 'object',
        properties: {
          producto_id: { type: 'integer', description: 'ID del producto (de buscar_producto)' },
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
      description: 'Elimina o reduce la cantidad de un producto del carrito.',
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
        'Lleva al cliente al checkout para finalizar su compra. ' +
        'Úsala cuando el cliente diga que quiere pagar o no encuentre el botón.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navegar_a',
      description:
        'Navega al cliente a cualquier sección de la app Aynimar. ' +
        'Úsala cuando el cliente pregunte cómo llegar a una sección.',
      parameters: {
        type: 'object',
        properties: {
          destino: {
            type: 'string',
            enum: Object.keys(APP_ROUTES),
            description: 'Sección destino de la app',
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
        'Envía alerta al equipo de Aynimar en Telegram. ' +
        'tipo="oportunidad": cliente busca producto sin stock (SOLO úsala si ya tienes nombre Y WhatsApp del cliente). ' +
        'tipo="critico": reclamo, reembolso o problema grave que requiere intervención humana.',
      parameters: {
        type: 'object',
        properties: {
          tipo:    { type: 'string', enum: ['oportunidad', 'critico'] },
          mensaje: {
            type: 'string',
            description: 'Resumen completo del caso. Para oportunidad debe incluir: Nombre del cliente, WhatsApp, producto buscado.',
          },
        },
        required: ['tipo', 'mensaje'],
      },
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────
const NUTRIA_SYSTEM_PROMPT = `Eres NutrIA, ejecutiva de ventas y soporte de alto rendimiento de Aynimar — plataforma de e-commerce circular en Ecuador.

MISIÓN: Maximizar conversiones, aumentar el ticket promedio y resolver soporte con autonomía total, protegiendo la reputación de la marca.

PERSONALIDAD: Carismática, empática, confiable, con jerga ecuatoriana sutil ("¡De una!", "Ya le veo", "Chévere", "¿en qué te ayudo, ve?"). Respuestas cortas. Estándar corporativo impecable. NUNCA menciones que eres IA si no te preguntan.

REGLA CRÍTICA — HERRAMIENTAS:
Las herramientas se ejecutan automáticamente en el servidor. NUNCA escribas "<function=...>", JSON de herramientas ni código en tus respuestas de texto. Tu texto es solo para hablar con el cliente en español natural.

CUÁNDO USAR CADA HERRAMIENTA:
• Cliente pregunta por precio/disponibilidad → buscar_producto() de inmediato.
• Cliente confirma que quiere un producto → agregar_al_carrito() con el id de buscar_producto().
• Cliente listo para pagar o no encuentra el botón → redirigir_checkout() sin preguntar.
• Cliente pregunta cómo llegar a una sección → navegar_a() directamente.
• Producto sin stock → di "¡Chuta, ese no lo tengo ahora! Pero no te preocupes, te lo gestiono personalmente. ¿Cómo te llamas?" — recoge primero el nombre, luego el WhatsApp en mensajes separados. Solo DESPUÉS de tener ambos → alertar_telegram(tipo="oportunidad").
• Reclamo grave / reembolso / problema complejo → alertar_telegram(tipo="critico") y avisa que un humano le contactará.
• Cliente da un ID de pedido → obtener_estado_orden().

CROSS-SELLING: Después de mostrar un producto, sugiere 1 complementario que agregue valor real según los intereses del cliente.

PRESENTACIÓN DE PRODUCTOS: Tras buscar_producto(), describe el producto de forma atractiva en texto natural (nombre, precio). Las tarjetas se muestran automáticamente. No repitas JSON.`;

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, clientActions, estadoActualizado) {
  const { models } = sequelize;

  if (name === 'buscar_producto') {
    try {
      const products = await models.Product.findAll({
        where: {
          [Op.or]: [
            { name:        { [Op.iLike]: `%${args.nombre}%` } },
            { description: { [Op.iLike]: `%${args.nombre}%` } },
          ],
          isDeleted: false,
          // showShop intentionally removed — query the full inventory
        },
        limit: 5,
        attributes: ['id', 'name', 'price', 'stock', 'description'],
      });

      if (products.length === 0) {
        return { encontrados: 0, productos: [], sinStock: true };
      }

      const payload = products.map((p) => ({
        id:          p.id,
        nombre:      p.name,
        precio:      p.price,
        stock:       p.stock ?? 'disponible',
        descripcion: (p.description || '').slice(0, 100),
      }));

      // Frontend will render product cards
      clientActions.push({ type: 'show_products', productos: payload });

      // Merge into historialIntereses for the state manager
      const nombres = payload.map((p) => p.nombre);
      estadoActualizado.historialIntereses = nombres;

      return { encontrados: payload.length, productos: payload };
    } catch (err) {
      console.error('[NutrIA:buscar_producto]', err.message);
      return { error: 'No pude consultar el inventario ahora.' };
    }
  }

  if (name === 'obtener_estado_orden') {
    try {
      const order = await models.Order.findByPk(args.orden_id, {
        attributes: ['id', 'state', 'stateOrder', 'createdAt', 'trackingNumber', 'carrierName'],
      });
      if (!order) return { error: 'Pedido no encontrado. Verifica el número.' };

      // Update tracking in state manager
      estadoActualizado.trackingSoporte = {
        ordenId: order.id,
        estado:  order.state,
      };

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
      return { error: 'No pude consultar el pedido ahora.' };
    }
  }

  // alertar_telegram — server-side only, never leaks to the client
  if (name === 'alertar_telegram') {
    const emoji  = args.tipo === 'critico' ? '⚠️' : '🚀';
    const titulo = args.tipo === 'critico' ? 'SOPORTE CRÍTICO' : 'OPORTUNIDAD DE VENTA';
    const sent   = await sendTelegram(`${emoji} <b>${titulo}</b>\n\n${args.mensaje}`);
    console.log(`[NutrIA:alertar_telegram] tipo=${args.tipo} sent=${sent}`);

    // Extract profile data from the message if available
    const extracted = extractProfileFromMensaje(args.mensaje);
    if (extracted.nombre || extracted.telefono) {
      estadoActualizado.perfilCliente = {};
      if (extracted.nombre)   estadoActualizado.perfilCliente.nombre   = extracted.nombre;
      if (extracted.telefono) estadoActualizado.perfilCliente.telefono = extracted.telefono;
    }

    return { enviado: sent };
  }

  // ── Client-side actions ───────────────────────────────────────────────────

  if (name === 'agregar_al_carrito') {
    clientActions.push({ type: 'add_to_cart', productoId: args.producto_id, cantidad: args.cantidad });
    // Reflect in state manager
    if (!estadoActualizado.estadoCarrito) estadoActualizado.estadoCarrito = {};
    estadoActualizado.estadoCarrito[args.producto_id] = args.cantidad;
    return { status: 'ok' };
  }

  if (name === 'eliminar_del_carrito') {
    clientActions.push({ type: 'remove_from_cart', productoId: args.producto_id, cantidad: args.cantidad });
    if (!estadoActualizado.estadoCarrito) estadoActualizado.estadoCarrito = {};
    estadoActualizado.estadoCarrito[args.producto_id] = 0; // frontend will clean up
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
// Accepts: { message: string, contexto: object }
// Returns: { reply: string, actions: array, estadoActualizado: object }
router.post('/nutria/chat', async (req, res, next) => {
  try {
    const { message, contexto } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ message: 'Se requiere el campo "message".' });
    }

    const groq = getGroqClient();
    if (!groq) {
      console.error('[NutrIA] GROQ_IA_KEY no configurada.');
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    // 70B model is reliable for tool calling; 8B writes function tags as text
    const model = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();

    // Build a compact context narrative from the structured state manager instead of
    // sending the raw conversation history — keeps the context window small
    const contextNarrative = buildContextNarrative(contexto);
    const systemContent    = NUTRIA_SYSTEM_PROMPT + contextNarrative;

    const conversationMessages = [
      { role: 'system', content: systemContent },
      { role: 'user',   content: message.trim() },
    ];

    const clientActions    = [];
    const estadoActualizado = {};
    const MAX_TOOL_ROUNDS  = 5;
    let round = 0;

    console.log(`[NutrIA] → model="${model}" context_chars=${systemContent.length}`);

    let completion = await groq.chat.completions.create({
      model,
      messages:    conversationMessages,
      tools:       NUTRIA_TOOLS,
      tool_choice: 'auto',
    });
    let choice = completion.choices[0];

    // Tool-calling loop — all tool execution happens silently on the server
    while (choice.finish_reason === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      round++;
      conversationMessages.push(choice.message);

      const toolResults = await Promise.all(
        (choice.message.tool_calls || []).map(async (tc) => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (_) { /* ignore */ }
          console.log(`[NutrIA] tool(${round}): ${tc.function.name}(${JSON.stringify(args)})`);
          const result = await executeTool(tc.function.name, args, clientActions, estadoActualizado);
          return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
        })
      );

      conversationMessages.push(...toolResults);

      completion = await groq.chat.completions.create({
        model,
        messages:    conversationMessages,
        tools:       NUTRIA_TOOLS,
        tool_choice: 'auto',
      });
      choice = completion.choices[0];
    }

    // Strip any leaked function-call artifacts before sending reply to the client
    const reply = sanitizeReply(choice.message?.content);

    console.log(`[NutrIA] ✓ reply=${reply.length}ch actions=${clientActions.length} rounds=${round}`);

    return res.json({
      reply,
      actions:          clientActions,
      estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
    });
  } catch (err) {
    console.error('[NutrIA] Error inesperado:', err.message);
    next(err);
  }
});

// ── POST /api/v1/ai/nutria/session-close ─────────────────────────────────────
// Generates emotional analytics and sends a session report to Telegram.
// Always returns 200 — non-fatal.
router.post('/nutria/session-close', async (req, res) => {
  try {
    const { history } = req.body;

    if (!Array.isArray(history) || history.length < 3) {
      return res.json({ ok: true });
    }

    const groq = getGroqClient();
    if (!groq || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      return res.json({ ok: true });
    }

    const model = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();

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
            'Responde ÚNICAMENTE con un objeto JSON válido (sin markdown) con estas claves exactas: ' +
            'emocion_inicial (string), emocion_final (string), nivel_interes (número 1-10), ' +
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
      analysis    = JSON.parse(match ? match[0] : raw);
    } catch (_) { /* keep empty */ }

    const msg =
      `📊 <b>Reporte de Sesión NutrIA</b>\n\n` +
      `😟 Emoción inicial: <b>${analysis.emocion_inicial ?? 'n/a'}</b>\n` +
      `😊 Emoción final:   <b>${analysis.emocion_final   ?? 'n/a'}</b>\n` +
      `⚡ Interés:          <b>${analysis.nivel_interes   ?? 'n/a'}/10</b>\n` +
      `🛍 Productos: ${(analysis.productos_mencionados ?? []).join(', ') || 'ninguno'}\n` +
      `🔧 Fricción:  ${(analysis.puntos_friccion       ?? []).join(', ') || 'ninguna'}\n` +
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
