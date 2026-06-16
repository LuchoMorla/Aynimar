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
// Plain text only — HTML tags in the system prompt corrupt tool call arguments.
function buildContextNarrative(contexto) {
  if (!contexto || typeof contexto !== 'object') return '';
  const lines = [];

  const { perfilCliente, historialIntereses, estadoCarrito, trackingSoporte } = contexto;

  if (perfilCliente) {
    if (perfilCliente.nombre)   lines.push(`- Cliente: ${perfilCliente.nombre}`);
    if (perfilCliente.telefono) lines.push(`- WhatsApp: ${perfilCliente.telefono}`);
  }

  if (Array.isArray(historialIntereses) && historialIntereses.length > 0) {
    lines.push(`- Intereses previos: ${historialIntereses.slice(-6).join(', ')}`);
  }

  if (estadoCarrito && typeof estadoCarrito === 'object') {
    const items = Object.entries(estadoCarrito)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => `id:${id} x${qty}`)
      .join(', ');
    if (items) lines.push(`- Carrito activo: ${items}`);
  }

  if (trackingSoporte?.ordenId) {
    lines.push(`- Pedido en seguimiento: #${trackingSoporte.ordenId}` +
      (trackingSoporte.estado ? ` (${trackingSoporte.estado})` : ''));
  }

  if (lines.length === 0) return '';
  return '\n\nCONTEXTO ACTIVO DEL CLIENTE:\n' + lines.join('\n');
}

// ── Normalize and validate tool arguments before execution ────────────────────
// Groq 70B sometimes generates extra fields, mistyped values, or aliased keys.
// This function coerces every tool's args to the exact shape our code expects,
// preventing Groq 400 errors from propagating when arg parsing goes wrong.
function normalizeToolArgs(name, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  if (name === 'buscar_producto') {
    // Accept any reasonable alias for the search term
    const term = String(r.nombre || r.query || r.producto || r.name || r.busqueda || '').trim();
    return { nombre: term || 'producto' };
  }

  if (name === 'obtener_estado_orden') {
    const id = parseInt(r.orden_id ?? r.orderId ?? r.id ?? 0, 10);
    return { orden_id: Number.isFinite(id) ? id : 0 };
  }

  if (name === 'agregar_al_carrito') {
    const pid = parseInt(r.producto_id ?? r.productId ?? r.id ?? 0, 10);
    const qty = Math.max(1, parseInt(r.cantidad ?? r.quantity ?? r.amount ?? 1, 10));
    return {
      producto_id: Number.isFinite(pid) ? pid : 0,
      cantidad:    Number.isFinite(qty) ? qty : 1,
    };
  }

  if (name === 'eliminar_del_carrito') {
    const pid = parseInt(r.producto_id ?? r.productId ?? r.id ?? 0, 10);
    const qty = Math.max(0, parseInt(r.cantidad ?? r.quantity ?? r.amount ?? 0, 10));
    return {
      producto_id: Number.isFinite(pid) ? pid : 0,
      cantidad:    Number.isFinite(qty) ? qty : 0,
    };
  }

  if (name === 'navegar_a') {
    const dest = String(r.destino || r.destination || r.page || '').toLowerCase().trim();
    return { destino: Object.prototype.hasOwnProperty.call(APP_ROUTES, dest) ? dest : 'tienda' };
  }

  if (name === 'alertar_telegram') {
    const tipo    = ['oportunidad', 'critico'].includes(r.tipo) ? r.tipo : 'oportunidad';
    const mensaje = String(r.mensaje || r.message || r.contenido || '').trim() || 'Sin detalles.';
    return { tipo, mensaje };
  }

  // redirigir_checkout — no args needed
  if (name === 'redirigir_checkout') return {};

  return r;
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
const NUTRIA_SYSTEM_PROMPT = `Eres NutrIA, ejecutiva élite de neuroventas de Aynimar — e-commerce circular en Ecuador.

MISIÓN: Maximizar conversiones activando los disparadores emocionales correctos. No vendes productos; vendes soluciones a dolores reales.

PERSONALIDAD: Carismática, cálida, jerga ecuatoriana sutil ("¡De una!", "¡Ya le veo!", "Chévere", "¡Oe!"). Respuestas cortas. NUNCA menciones que eres IA si no te preguntan.

━━━ REGLA TÉCNICA — HERRAMIENTAS ━━━
Las herramientas se ejecutan en silencio en el servidor.
NUNCA escribas "<function=...>", JSON ni código en tus respuestas de texto.

━━━ PASO 0 — CLASIFICACIÓN REPTILIANA (ANTES DE RESPONDER) ━━━
Ante cada mensaje, identifica internamente el código emocional dominante del cliente:
• Proteccion/Seguridad → "no quiero quedarme incomunicado / sin luz"
• Dominacion/Poder → "quiero el equipo mas pro, destacar"
• Pertenencia → "todos en el grupo tienen esto"
• Trascendencia → "quiero calidad que dure anos"
• Exploracion/Placer → "me voy de excursion, quiero disfrutar sin trabas"
• Ahorro de Energia → "quiero algo que funcione de una, sin complicaciones"
• Libertad/Autonomia → "no quiero ataduras, ser independiente"
• Reconocimiento/Estatus → "busco lo mejor, lo que me hace ver bien"
Usa ese codigo para elegir las palabras exactas de tu reply. Nunca lo menciones en voz alta.

━━━ ESTRUCTURA DE RESPUESTA NEURO-VENDEDORA (A→B→C→D) ━━━
Toda presentacion de producto sigue esta arquitectura:
A. VALIDACION — Conecta con el dolor del cliente:
   "Chuta, quedarse sin carga en plena calle es un riesgo de verdad, ve..."
B. SOLUCION — El producto como via mas sencilla:
   "Para que no te compliques ni un segundo, este te da energia sin trabas..."
C. BENEFICIO EMOCIONAL — Apela al codigo principal detectado:
   "Con esto sales tranquilo, sabiendo que tu tienes el control total, ve..."
D. CTA SIN FRICCION — La tarjeta aparece sola; di solo:
   "Te lo agrego al carrito de una, confirmas?"

━━━ PRIORIDAD ABSOLUTA: RE-EVALUACION EN CUALQUIER TURNO ━━━
Si en CUALQUIER momento el cliente menciona un producto concreto, nueva necesidad o pista de hardware
("powerbank", "linterna", "fuente", "solar", etc.) DEBES:
1. PARAR inmediatamente (incluso si recolectabas nombre/telefono)
2. Llamar buscar_producto() con el nuevo termino
3. Solo si esa busqueda retorna 0, retomar la recoleccion de datos
La busqueda real SIEMPRE tiene prioridad sobre cualquier otra tarea.

━━━ INFERENCIA CREATIVA DE NECESIDAD ━━━
Ante dolores ambiguos, haz UNA pregunta consultiva ecuatoriana para descubrir el codigo reptiliano
antes de disparar buscar_producto(). Esto califica al cliente y afina la busqueda:

NECESIDADES DE ENERGIA (celular, bateria, carga):
- Cliente dice "se me descarga el celular", "me quedo sin bateria", "necesito carga" →
  PREGUNTA CONSULTIVA: "¿Te vas de excursion o aventura y necesitas energia total en la naturaleza,
  o buscas algo compacto para el dia a dia en el trabajo para no quedarte incomunicado, ve?"
  → Respuesta "excursion / viaje / naturaleza" → codigo Exploracion → busca "solar" o "kit generador"
  → Respuesta "trabajo / dia a dia / calle / ciudad" → codigo Seguridad → busca "powerbank"
  → Si el cliente menciona "cable" o "cargador de casa" → codigo Ahorro de Energia → busca "cargador"

CUANDO BUSCAR DIRECTAMENTE (sin pregunta):
- "me voy de excursion / camping / viaje" → codigo Exploracion → busca "solar" o "kit generador"
- "me hacen bullying / quiero deporte" → codigo Dominacion → busca "guantes box"
- "quiero quedar bien con mi jefe / regalar" → codigo Reconocimiento → busca "kit" o "gadget"
- "no tengo luz" → codigo Seguridad → busca "linterna" o "solar"
- "necesito un cable" o "mi cargador se daño" → busca "cargador" directamente
- "quiero el [nombre especifico de producto]" → busca de inmediato sin preguntar

Cuando encuentres un alternativo, presentalo como LA solucion perfecta antes de mencionar que no tienes el exacto.

━━━ BUSQUEDA ANTES DE OBJECION — LEY ABSOLUTA ━━━
NUNCA digas "no tengo" sin haber llamado buscar_producto() al menos UNA vez.
Si el resultado es { encontrados: 0 }:
  1. Intenta UNA busqueda alternativa con sinonimo o categoria mas amplia
  2. Si ambas busquedas dan 0, varia el lenguaje (NUNCA repitas la misma frase exacta):
     - Con nombre del cliente: "Mira [nombre], ese exacto no lo tenemos, pero..."
     - Sin nombre: alterna "Ay, que pena!", "Oe, ese no lo manejamos ahorita!", "Veerito que no tenemos ese!", etc.
  3. Recoge nombre (primero) y WhatsApp (luego, en mensaje separado)
  4. Con AMBOS datos → alertar_telegram(tipo="oportunidad")
  5. Si el cliente menciona otro producto en cualquier momento → vuelve al paso 1

━━━ CUANDO USAR CADA HERRAMIENTA ━━━
- Necesidad/dolor/producto mencionado → buscar_producto() de inmediato
- Cliente confirma querer un producto → agregar_al_carrito() con el id de buscar_producto()
- Cliente listo para pagar → redirigir_checkout() sin preguntar
- Cliente pregunta como ir a una seccion → navegar_a() directamente
- Reclamo/problema grave → alertar_telegram(tipo="critico"), avisa que un humano le contactara
- Cliente da ID de pedido → obtener_estado_orden()

CROSS-SELLING: Despues de D, sugiere 1 complementario alineado al mismo codigo emocional del cliente.
PRESENTACION: Texto natural con nombre y precio. Las tarjetas aparecen solas. No repitas JSON.`;

// ── Synonym expansion for buscar_producto ────────────────────────────────────
// Products may be stored under technical or commercial names different from
// what the customer says. This maps common search terms to DB-friendly variants.
const SYNONYM_MAP = {
  powerbank:   ['powerbank', 'power bank', 'cargador portátil', 'batería portátil', 'banco energía', 'carga'],
  batería:     ['batería', 'pila', 'powerbank', 'acumulador', 'carga portátil'],
  cargador:    ['cargador', 'powerbank', 'adaptador', 'cable carga', 'power bank'],
  solar:       ['solar', 'panel solar', 'generador solar', 'kit solar', 'energía solar'],
  linterna:    ['linterna', 'lámpara', 'luz led', 'farol', 'luz'],
  auricular:   ['auricular', 'audífono', 'headset', 'earphone', 'earbuds', 'bluetooth'],
  audífono:    ['audífono', 'auricular', 'headset', 'earphone', 'headphones'],
  cable:       ['cable', 'adaptador', 'conector', 'usb', 'cargador'],
  box:         ['box', 'boxeo', 'guantes box', 'saco box', 'deporte'],
  guantes:     ['guantes', 'box', 'boxeo', 'deporte', 'entrenamiento'],
  deporte:     ['deporte', 'box', 'guantes', 'entrenamiento', 'gimnasio', 'pesas'],
  mochila:     ['mochila', 'bolso', 'maletín', 'morral', 'bolsa'],
  excursión:   ['excursión', 'camping', 'outdoor', 'solar', 'linterna', 'kit'],
  camping:     ['camping', 'outdoor', 'solar', 'linterna', 'carpa', 'excursión'],
  regalo:      ['regalo', 'kit', 'set', 'pack', 'combo'],
};

function expandSearchTerms(term) {
  const norm = term.toLowerCase().trim();
  for (const [key, variants] of Object.entries(SYNONYM_MAP)) {
    if (norm.includes(key)) return [...new Set([term, ...variants])];
  }
  return [term];
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, clientActions, estadoActualizado) {
  const { models } = sequelize;

  if (name === 'buscar_producto') {
    try {
      const terms    = expandSearchTerms(args.nombre);
      const orClauses = terms.flatMap((t) => [
        { name:        { [Op.iLike]: `%${t}%` } },
        { description: { [Op.iLike]: `%${t}%` } },
      ]);

      const products = await models.Product.findAll({
        where: { [Op.or]: orClauses, isDeleted: false },
        limit: 5,
        attributes: ['id', 'name', 'price', 'stock', 'description'],
      });

      console.log(`[NutrIA Debug] Resultado de Query PostgreSQL para "${args.nombre}" (terms: ${terms.join(', ')}):`, products.length, 'resultados');

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
// Accepts: { message: string, history: array, contexto: object }
// Returns: { reply: string, actions: array, estadoActualizado: object }
router.post('/nutria/chat', async (req, res) => {
  try {
    const { message, history, contexto } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ message: 'Se requiere el campo "message".' });
    }

    // ── Diagnostic: log what the client actually sent ──────────────────────
    console.log('[NutrIA Debug] Mensaje Recibido:', message);
    console.log('[NutrIA Debug] Contexto Recibido:', JSON.stringify(contexto ?? null));

    const groq = getGroqClient();
    if (!groq) {
      console.error('[NutrIA] GROQ_IA_KEY no configurada.');
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    // 70B model is reliable for tool calling; 8B writes function tags as text
    const model = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();

    // Restore conversation history so the model can follow multi-turn flows
    // (e.g. "¿Cómo te llamas?" → "Luis" requires context of the previous turn).
    // history[] contains all previous turns EXCEPT the current message — no duplication.
    const safeHistory = Array.isArray(history)
      ? history.filter(
          (m) => m && typeof m.role === 'string' && typeof m.content === 'string'
            && ['user', 'assistant'].includes(m.role)
        )
      : [];

    // contexto enriches the system prompt with structured profile/cart data
    const contextNarrative = buildContextNarrative(contexto);
    const systemContent    = NUTRIA_SYSTEM_PROMPT + contextNarrative;

    const conversationMessages = [
      { role: 'system', content: systemContent },
      ...safeHistory,
      { role: 'user',   content: message.trim() },
    ];

    const clientActions    = [];
    const estadoActualizado = {};
    const MAX_TOOL_ROUNDS  = 5;
    let round = 0;

    console.log(`[NutrIA] → model="${model}" history=${safeHistory.length} turns context_chars=${systemContent.length}`);

    // ── First Groq call ───────────────────────────────────────────────────────
    let completion;
    try {
      completion = await groq.chat.completions.create({
        model,
        messages:    conversationMessages,
        tools:       NUTRIA_TOOLS,
        tool_choice: 'auto',
      });
    } catch (groqInitErr) {
      console.error('[NutrIA] Groq initial call error:', groqInitErr.message);
      return res.json({
        reply: '¡Hola! Tuve un problemita técnico momentáneo. ¿Me repites tu pregunta? 🦦',
        actions: [],
        estadoActualizado: null,
      });
    }

    let choice = completion.choices[0];

    // ── Diagnostic: did Groq decide to call a tool? ───────────────────────────
    console.log('[NutrIA Debug] ¿Groq decidió llamar tool?:', JSON.stringify(choice.message.tool_calls ?? null));

    // ── Tool-calling loop — all execution happens silently on the server ──────
    while (choice.finish_reason === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      round++;
      conversationMessages.push(choice.message);

      const toolResults = await Promise.all(
        (choice.message.tool_calls || []).map(async (tc) => {
          // Parse args — silently fall back to {} if JSON is malformed
          let rawArgs = {};
          try { rawArgs = JSON.parse(tc.function.arguments); } catch (_) { /* malformed JSON */ }

          // Normalize to the exact shape each tool expects, stripping extra/mistyped fields
          const args = normalizeToolArgs(tc.function.name, rawArgs);
          console.log(`[NutrIA] tool(${round}): ${tc.function.name}(${JSON.stringify(args)})`);

          let result;
          try {
            result = await executeTool(tc.function.name, args, clientActions, estadoActualizado);
          } catch (toolErr) {
            console.error(`[NutrIA] Tool execution error (${tc.function.name}):`, toolErr.message);
            result = { error: 'Herramienta no disponible temporalmente.' };
          }

          return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
        })
      );

      conversationMessages.push(...toolResults);

      // Groq 400 in the loop must NEVER reach the client — return what we have
      try {
        completion = await groq.chat.completions.create({
          model,
          messages:    conversationMessages,
          tools:       NUTRIA_TOOLS,
          tool_choice: 'auto',
        });
        choice = completion.choices[0];
      } catch (groqLoopErr) {
        console.error(`[NutrIA] Groq error in loop (round ${round}):`, groqLoopErr.message);
        return res.json({
          reply: '¡Uy, tuve un inconveniente buscando eso! ¿Me repites qué producto buscas? 🦦',
          actions: clientActions,
          estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
        });
      }
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
    // Last-resort catch: return friendly message, not a 400/500 to the client
    return res.json({
      reply: 'Tuve un inconveniente técnico. Inténtalo de nuevo en un momento 🦦.',
      actions: [],
      estadoActualizado: null,
    });
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
