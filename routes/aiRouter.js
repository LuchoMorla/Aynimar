'use strict';
/* eslint-disable no-console */

const express  = require('express');
const passport = require('passport');
const OpenAI   = require('openai');
const { Op }   = require('sequelize');
const { checkRoles }          = require('../middlewares/authHandler');
const {
  optimizeProductCopy,
  NEURO_SYSTEM_PROMPT,
  buildNeuroCopyUserContent,
} = require('../integrations/aiCopyService');
const { completeManual2FA }   = require('../integrations/dropi/dropiAuthService');
const sequelize               = require('../libs/sequelize');

const router = express.Router();

// ── Groq client ───────────────────────────────────────────────────────────────
const MODEL_PRIMARY  = 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = 'llama-3.1-8b-instant';

// In-memory order cache — one DB hit per order per 5 min regardless of tool-call repetitions
const ORDER_CACHE     = new Map();
const ORDER_CACHE_TTL = 5 * 60 * 1000;
function cachedOrder(id) {
  const e = ORDER_CACHE.get(id);
  if (!e || Date.now() - e.ts > ORDER_CACHE_TTL) { ORDER_CACHE.delete(id); return null; }
  return e.data;
}
function cacheOrder(id, data) { ORDER_CACHE.set(id, { data, ts: Date.now() }); }

// ── Sales performance logger (fire-and-forget) ────────────────────────────────
function logSalesEvent(models, { sessionId, outcome, productIds, turns, lastIntent, toolCallNames }) {
  if (!models?.SalesPerformance) return;
  models.SalesPerformance.create({
    sessionId:  sessionId.slice(0, 64),
    outcome,
    productIds: productIds?.length > 0 ? productIds : null,
    turns,
    lastIntent: lastIntent ? lastIntent.slice(0, 500) : null,
    toolCalls:  toolCallNames?.length > 0 ? toolCallNames : null,
  }).catch((err) => console.error('[SalesPerformance] log error:', err.message));
}

class RateLimitError extends Error {
  constructor() { super('rate_limit'); this.isRateLimit = true; }
}

// ── Telegram auto-discovery state ─────────────────────────────────────────────
// Populated by the /telegram/webhook endpoint the first time a message arrives.
// Used as last-resort fallback when neither TELEGRAM_OWNER_ID nor TELEGRAM_CHAT_ID is set.
let detectedOwnerId = null;
let ownerIdWarned   = false;

function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_IA_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
}

// Patterns that justify the 70B model (comparison, deep reasoning, neurosales analysis)
const COMPLEX_RE = /compar[ae]|diferencia|mejor.*que|\bvs\b|versus|reptili|neuroven|por qu[eé]|expl[ií]ca|anal[iy]z|filosof|psicolog|estrategia|consejo.*negocio|c[oó]mo vender|qu[eé] es mejor|recomend.*entre/i;

function pickModel(message) {
  return COMPLEX_RE.test(message) ? MODEL_PRIMARY : MODEL_FALLBACK;
}

// safeGroqCall: 70B→8B fallback on 429; throws RateLimitError when both models are saturated
async function safeGroqCall(groq, params) {
  try {
    return await groq.chat.completions.create(params);
  } catch (err) {
    if (err.status === 429 || err.statusCode === 429) {
      if (params.model === MODEL_PRIMARY) {
        console.error('[NutrIA] 429 on 70B — retrying with 8B');
        try {
          return await groq.chat.completions.create({ ...params, model: MODEL_FALLBACK });
        } catch (e2) {
          throw (e2.status === 429 || e2.statusCode === 429) ? new RateLimitError() : e2;
        }
      }
      throw new RateLimitError();
    }
    throw err;
  }
}

// ── Telegram helper ───────────────────────────────────────────────────────────
// Priority: TELEGRAM_OWNER_ID → TELEGRAM_CHAT_ID → auto-discovered detectedOwnerId
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_CHAT_ID || detectedOwnerId;
  if (!token || !chatId) {
    console.warn('[NutrIA] Telegram no configurado — envía un mensaje al bot para auto-detectar el chat_id.');
    return false;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await resp.json();
    if (!data.ok) console.error('[NutrIA] Telegram error:', JSON.stringify(data));
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
    let orderLine = `- Pedido #${trackingSoporte.ordenId}: estado=${trackingSoporte.estado ?? 'n/a'}`;
    if (trackingSoporte.guia)          orderLine += `, guia=${trackingSoporte.guia}`;
    if (trackingSoporte.transportista) orderLine += `, carrier=${trackingSoporte.transportista}`;
    orderLine += ' — DATOS YA CARGADOS, NO vuelvas a llamar obtener_estado_orden()';
    lines.push(orderLine);
  }

  if (Array.isArray(contexto.ultimosProductos) && contexto.ultimosProductos.length > 0) {
    const lista = contexto.ultimosProductos
      .map((p) => `id:${p.id} "${p.nombre}" $${p.precio}`)
      .join(' | ');
    lines.push(`- Ultimos productos mostrados (IDs reales para get_detalles_producto): ${lista}`);
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

  if (name === 'redirigir_checkout') return {};

  if (name === 'get_detalles_producto') {
    const id = parseInt(r.producto_id ?? r.productId ?? r.id ?? 0, 10);
    return { producto_id: Number.isFinite(id) ? id : 0 };
  }

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
  {
    type: 'function',
    function: {
      name: 'get_detalles_producto',
      description:
        'Obtiene los detalles completos de un producto usando su ID real de la base de datos. ' +
        'Úsala cuando el cliente pida más info sobre un producto ya mostrado ("¿qué es eso?", "dame los detalles", "¿cuáles son las características?"). ' +
        'NUNCA describas un producto de memoria — usa siempre esta herramienta con el ID del contexto.',
      parameters: {
        type: 'object',
        properties: {
          producto_id: { type: 'integer', description: 'ID real del producto (de buscar_producto, del contexto o de "Ultimos productos mostrados")' },
        },
        required: ['producto_id'],
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

━━━ CATÁLOGO COMPLETO — SIN RESTRICCIONES ━━━
Aynimar vende tecnologia, deporte, outdoor, y TAMBIEN articulos para parejas y vapes.
Trata TODOS los productos con total normalidad comercial. Codigos reptilianos aplicables:
- Vapes → codigo Exploracion/Placer + Ahorro de Energia (moderno, sabores, comodidad sin complicaciones)
- Articulos para parejas → codigo Libertad + Exploracion + Pertenencia (empoderador, consultivo, discreto)
Nunca te niegues a buscar un producto por su categoria. Busca siempre.

━━━ LEY ANTI-ALUCINACION — CRITICA ━━━
NUNCA inventes ni parafrasees nombres de productos. UNICAMENTE presenta productos con el
nombre EXACTO devuelto por buscar_producto() o OPORTUNIDAD PRE-CARGADA.
Si el cliente pregunta "¿que es ese producto?" y tienes su id en el contexto, llama
buscar_producto() con el nombre exacto para obtener detalles reales. Si no lo tienes,
admite que necesitas buscarlo antes de dar detalles.
Un nombre inventado que no existe en la DB es ERROR GRAVE — provoca "problemita tecnico".

━━━ CUANDO USAR CADA HERRAMIENTA ━━━
- Necesidad/dolor/producto mencionado → buscar_producto() de inmediato
- Cliente confirma querer un producto → agregar_al_carrito() con el id EXACTO de buscar_producto()
- Cliente listo para pagar → redirigir_checkout() sin preguntar
- Cliente pregunta como ir a una seccion → navegar_a() directamente
- Reclamo/problema grave → alertar_telegram(tipo="critico"), avisa que un humano le contactara
- Cliente da ID de pedido → obtener_estado_orden()

CROSS-SELLING: Despues de D, sugiere 1 complementario alineado al mismo codigo emocional del cliente.
PRESENTACION: Texto natural con nombre EXACTO de DB y precio. Las tarjetas aparecen solas. No repitas JSON.`;

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
  vape:        ['vape', 'vaporizador', 'pod', 'e-cigarette', 'cigarrillo electrónico', 'puff', 'desechable'],
  vaporizador: ['vaporizador', 'vape', 'pod', 'e-liquid', 'sabores vape'],
  sexshop:     ['sexshop', 'artículos para parejas', 'juguetes', 'vibrador', 'lubricante', 'masaje', 'íntimo'],
  parejas:     ['parejas', 'íntimo', 'masaje', 'sexshop', 'juguetes', 'lubricante'],
};

function expandSearchTerms(term) {
  const norm = term.toLowerCase().trim();
  for (const [key, variants] of Object.entries(SYNONYM_MAP)) {
    if (norm.includes(key)) return [...new Set([term, ...variants])];
  }
  return [term];
}

// ── Internal Needs-Driven Semantic Engine ─────────────────────────────────────
// Runs server-side on every request BEFORE the Groq call.
// Maps customer pain patterns to reptilian codes + product search terms,
// pre-fetching inventory so the model gets real catalog data in its context.
const NEEDS_MAP = [
  {
    codigo: 'exploracion',
    label: 'Exploracion/Placer',
    patterns: [/excursi[oó]n|camping|aventura|naturaleza|monta[nñ]|viaje de campo|outdoor|trekking/i],
    ambiguous: false,
    searchTerms: ['solar', 'kit generador', 'linterna'],
  },
  {
    codigo: 'seguridad_energia',
    label: 'Proteccion/Seguridad - Energia',
    patterns: [/se me descarg|quedo sin bater[ií]a|sin carga|bater[ií]a baja|apagado.*celular|celular.*apag/i],
    ambiguous: true,
    preguntaConsultiva: '¿Necesitas algo para llevar en la calle (powerbank compacto) o te vas de aventura en la naturaleza, ve?',
  },
  {
    codigo: 'seguridad_luz',
    label: 'Proteccion/Seguridad - Iluminacion',
    patterns: [/sin luz|apag[oó]n|no tengo luz|falta electricidad|corte de luz|oscuridad/i],
    ambiguous: false,
    searchTerms: ['linterna', 'solar'],
  },
  {
    codigo: 'dominacion',
    label: 'Dominacion/Poder',
    patterns: [/bullying|me molestan|quiero ser fuerte|entrenar|deport|boxeo|guantes|gimnas/i],
    ambiguous: false,
    searchTerms: ['guantes box', 'deporte'],
  },
  {
    codigo: 'reconocimiento',
    label: 'Reconocimiento/Estatus',
    patterns: [/quedar bien|impresionar|regalo para|busco lo mejor|de calidad|regalo.*cumplea[nñ]|jefe|regalo.*novia|regalo.*novio/i],
    ambiguous: false,
    searchTerms: ['kit', 'gadget', 'regalo'],
  },
  {
    codigo: 'ahorro_energia',
    label: 'Ahorro de Energia',
    patterns: [/cargador.*casa|cable.*roto|adaptador|mi cargador se da[nñ]o|necesito cable|cable usb/i],
    ambiguous: false,
    searchTerms: ['cargador', 'cable'],
  },
  {
    codigo: 'libertad',
    label: 'Libertad/Autonomia',
    patterns: [/sin cable|inal[aá]mbric|bluetooth|aut[oó]nom|auricular|earphone|headset/i],
    ambiguous: false,
    searchTerms: ['auricular', 'bluetooth'],
  },
  {
    codigo: 'placer_vape',
    label: 'Exploracion/Placer - Vape',
    patterns: [/vap[eo]|vaporizador|pod |puff|cigarrillo electr[oó]nico|e-liquid|fumar algo/i],
    ambiguous: false,
    searchTerms: ['vape', 'vaporizador'],
  },
  {
    codigo: 'placer_intimo',
    label: 'Exploracion/Placer - Intimo',
    patterns: [/sexshop|art[íi]culos para pareja|juguetes.*pareja|algo.*pareja|vida.*[íi]ntim|lubricante|vibrador/i],
    ambiguous: false,
    searchTerms: ['sexshop', 'parejas', 'íntimo'],
  },
];

function evaluarNecesidadesCliente(mensaje) {
  const text = (mensaje || '').toLowerCase();
  for (const need of NEEDS_MAP) {
    if (need.patterns.some((p) => p.test(text))) {
      return {
        codigo:             need.codigo,
        label:              need.label,
        ambiguous:          need.ambiguous,
        searchTerms:        need.searchTerms       ?? null,
        preguntaConsultiva: need.preguntaConsultiva ?? null,
      };
    }
  }
  return null;
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, clientActions, estadoActualizado) {
  const { models } = sequelize;

  if (name === 'buscar_producto') {
    try {
      // Cap to 3 terms max (primary + 2 synonyms) to keep OR clause short
      const terms     = expandSearchTerms(args.nombre).slice(0, 3);
      const orClauses = terms.flatMap((t) => [
        { name:        { [Op.iLike]: `%${t}%` } },
        { description: { [Op.iLike]: `%${t}%` } },
      ]);

      // Query 1: search by product name + description
      let products = await models.Product.findAll({
        where: { [Op.or]: orClauses, isDeleted: false },
        limit: 5,
        attributes: ['id', 'name', 'price', 'stock', 'description', 'image'],
      });

      // Query 2 (fallback only): match by category name when Q1 returns nothing
      if (products.length === 0) {
        const primaryTerm = args.nombre;
        const categories  = await models.Category.findAll({
          where: { name: { [Op.iLike]: `%${primaryTerm}%` } },
          attributes: ['id'],
          limit: 3,
        });
        if (categories.length > 0) {
          const catIds = categories.map((c) => c.id);
          products = await models.Product.findAll({
            where: { categoryId: { [Op.in]: catIds }, isDeleted: false },
            limit: 5,
            attributes: ['id', 'name', 'price', 'stock', 'description', 'image'],
          });
        }
      }

      if (products.length === 0) {
        return { encontrados: 0, productos: [], sinStock: true };
      }

      const payload = products.map((p) => ({
        id:          p.id,
        nombre:      p.name,
        precio:      p.price,
        stock:       p.stock ?? 'disponible',
        descripcion: (p.description || '').slice(0, 100),
        imagen:      p.image || null,
      }));

      // Frontend will render product cards
      clientActions.push({ type: 'show_products', productos: payload });

      // Merge into historialIntereses and ultimosProductos for the state manager
      const nombres = payload.map((p) => p.nombre);
      estadoActualizado.historialIntereses = nombres;
      estadoActualizado.ultimosProductos   = payload.slice(0, 3).map((p) => ({ id: p.id, nombre: p.nombre, precio: p.precio }));

      return { encontrados: payload.length, productos: payload };
    } catch (err) {
      console.error('[NutrIA:buscar_producto]', err.message);
      return { error: 'No pude consultar el inventario ahora.' };
    }
  }

  if (name === 'obtener_estado_orden') {
    try {
      const hit = cachedOrder(args.orden_id);
      if (hit) {
        estadoActualizado.trackingSoporte = {
          ordenId: hit.id, estado: hit.estado, guia: hit.guia, transportista: hit.transportista,
        };
        return hit;
      }

      const order = await models.Order.findByPk(args.orden_id, {
        attributes: ['id', 'state', 'stateOrder', 'createdAt', 'trackingNumber', 'carrierName'],
      });
      if (!order) return { error: 'Pedido no encontrado. Verifica el número.' };

      const result = {
        id:            order.id,
        estado:        order.state,
        detalle:       order.stateOrder,
        guia:          order.trackingNumber ?? null,
        transportista: order.carrierName    ?? null,
        creado:        order.createdAt,
      };
      cacheOrder(args.orden_id, result);
      estadoActualizado.trackingSoporte = {
        ordenId:       order.id,
        estado:        order.state,
        detalle:       order.stateOrder,
        guia:          order.trackingNumber ?? null,
        transportista: order.carrierName    ?? null,
      };
      return result;
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

    // Extract profile data from the message if available
    const extracted = extractProfileFromMensaje(args.mensaje);
    if (extracted.nombre || extracted.telefono) {
      estadoActualizado.perfilCliente = {};
      if (extracted.nombre)   estadoActualizado.perfilCliente.nombre   = extracted.nombre;
      if (extracted.telefono) estadoActualizado.perfilCliente.telefono = extracted.telefono;
    }

    return { enviado: sent };
  }

  if (name === 'get_detalles_producto') {
    try {
      const product = await models.Product.findByPk(args.producto_id, {
        attributes: ['id', 'name', 'price', 'stock', 'description', 'image'],
      });
      if (!product) return { error: 'Producto no encontrado. Verifica el ID.' };
      return {
        id:          product.id,
        nombre:      product.name,
        precio:      product.price,
        stock:       product.stock ?? 'disponible',
        descripcion: product.description,
        imagen:      product.image || null,
      };
    } catch (err) {
      console.error('[NutrIA:get_detalles_producto]', err.message);
      return { error: 'No pude obtener los detalles del producto.' };
    }
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

    const groq = getGroqClient();
    if (!groq) {
      console.error('[NutrIA] GROQ_IA_KEY no configurada.');
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    // Pick model based on message complexity; 8B handles most sales chats
    const model = process.env.GROQ_MODEL || pickModel(message.trim());

    // Keep last 6 turns (12 messages) — enough context without burning tokens
    const safeHistory = Array.isArray(history)
      ? history
          .filter(
            (m) => m && typeof m.role === 'string' && typeof m.content === 'string'
              && ['user', 'assistant'].includes(m.role)
          )
          .slice(-6)
      : [];

    const clientActions     = [];
    const estadoActualizado = {};
    const MAX_TOOL_ROUNDS   = 5;
    let round = 0;

    // ── Internal Needs Engine — pre-fetch catalog before Groq call ────────────
    // Avoids a full tool-call round-trip for predictable pain→product matches.
    const contextNarrative = buildContextNarrative(contexto);
    let oportunidadStr = '';
    const needsMatch = evaluarNecesidadesCliente(message.trim());

    if (needsMatch) {
      if (!needsMatch.ambiguous && Array.isArray(needsMatch.searchTerms) && needsMatch.searchTerms.length > 0) {
        try {
          const { models } = sequelize;
          // Cap to 3 terms to keep the OR clause lightweight
          const allTerms  = [...new Set(needsMatch.searchTerms.flatMap((t) => expandSearchTerms(t)))].slice(0, 3);
          const orClauses = allTerms.flatMap((t) => [
            { name:        { [Op.iLike]: `%${t}%` } },
            { description: { [Op.iLike]: `%${t}%` } },
          ]);
          const preProd = await models.Product.findAll({
            where: { [Op.or]: orClauses, isDeleted: false },
            limit: 4,
            attributes: ['id', 'name', 'price', 'stock', 'description', 'image'],
          });
          if (preProd.length > 0) {
            const payload = preProd.map((p) => ({
              id:          p.id,
              nombre:      p.name,
              precio:      p.price,
              stock:       p.stock ?? 'disponible',
              descripcion: (p.description || '').slice(0, 60),
              imagen:      p.image || null,
            }));
            clientActions.push({ type: 'show_products', productos: payload });
            if (!estadoActualizado.historialIntereses) estadoActualizado.historialIntereses = [];
            estadoActualizado.historialIntereses.push(...payload.map((p) => p.nombre));
            estadoActualizado.ultimosProductos = payload.slice(0, 3).map((p) => ({ id: p.id, nombre: p.nombre, precio: p.precio }));

            const lista = payload.map((p) => `- ${p.nombre} | $${p.precio} | id:${p.id}`).join('\n');
            oportunidadStr = `\n\nOPORTUNIDAD PRE-CARGADA (${needsMatch.label}):\n${lista}\nReply con A-B-C-D. NO llames buscar_producto() este turno.`;
          }
        } catch (engineErr) {
          console.error('[NutrIA] Pre-fetch error:', engineErr.message);
        }
      } else if (needsMatch.ambiguous && needsMatch.preguntaConsultiva) {
        oportunidadStr = `\n\nDOLOR AMBIGUO (${needsMatch.label}): Pregunta antes de buscar: "${needsMatch.preguntaConsultiva}"`;
      }
    }

    const systemContent = NUTRIA_SYSTEM_PROMPT + contextNarrative + oportunidadStr;

    const conversationMessages = [
      { role: 'system', content: systemContent },
      ...safeHistory,
      { role: 'user',   content: message.trim() },
    ];

    const groqParams = { model, messages: conversationMessages, tools: NUTRIA_TOOLS, tool_choice: 'auto' };

    // ── First Groq call (with 70B→8B fallback on 429) ────────────────────────
    let completion;
    try {
      completion = await safeGroqCall(groq, groqParams);
    } catch (groqInitErr) {
      if (groqInitErr.isRateLimit) {
        await new Promise((r) => setTimeout(r, 5000));
        return res.json({
          message:           '¡Chuta! Dame un segundo que el sistema está procesando a máxima velocidad, ya te doy el precio. 🦦',
          products:          [],
          actions:           clientActions.filter((a) => a.type !== 'show_products'),
          estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
        });
      }
      console.error('[NutrIA] Groq initial call failed:', groqInitErr.message);
      return res.json({
        message:           '¡Chuta! Me distraje un momento. ¿Lo intentamos de nuevo? 🦦',
        products:          [],
        actions:           clientActions.filter((a) => a.type !== 'show_products'),
        estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
      });
    }

    let choice = completion.choices[0];

    // ── Tool-calling loop ─────────────────────────────────────────────────────
    while (choice.finish_reason === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      round++;
      conversationMessages.push(choice.message);

      const toolResults = await Promise.all(
        (choice.message.tool_calls || []).map(async (tc) => {
          let rawArgs = {};
          try { rawArgs = JSON.parse(tc.function.arguments); } catch (_) { /* malformed */ }

          const args = normalizeToolArgs(tc.function.name, rawArgs);

          let result;
          try {
            result = await executeTool(tc.function.name, args, clientActions, estadoActualizado);
          } catch (toolErr) {
            console.error(`[NutrIA] Tool error (${tc.function.name}):`, toolErr.message);
            result = { error: 'Herramienta no disponible temporalmente.' };
          }

          return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
        })
      );

      conversationMessages.push(...toolResults);

      try {
        completion = await safeGroqCall(groq, { ...groqParams, messages: conversationMessages });
        choice = completion.choices[0];
      } catch (groqLoopErr) {
        if (groqLoopErr.isRateLimit) {
          await new Promise((r) => setTimeout(r, 5000));
          return res.json({
            message:           '¡Chuta! Dame un segundo que el sistema está procesando a máxima velocidad, ya te doy el precio. 🦦',
            products:          clientActions.filter((a) => a.type === 'show_products').flatMap((a) => a.productos ?? []),
            actions:           clientActions.filter((a) => a.type !== 'show_products'),
            estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
          });
        }
        console.error('[NutrIA] Groq loop error:', groqLoopErr.message);
        return res.json({
          message:           '¡Chuta! Me distraje buscando, ¿probamos con otro término? 🦦',
          products:          clientActions.filter((a) => a.type === 'show_products').flatMap((a) => a.productos ?? []),
          actions:           clientActions.filter((a) => a.type !== 'show_products'),
          estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
        });
      }
    }

    const reply = sanitizeReply(choice.message?.content);

    // Hoist products to a top-level key so the frontend reads them directly
    // without traversing the actions array (prevents silent null on no-tool turns)
    const products     = clientActions
      .filter((a) => a.type === 'show_products')
      .flatMap((a) => a.productos ?? []);
    const otherActions = clientActions.filter((a) => a.type !== 'show_products');

    // ── Sales performance logging (fire-and-forget) ───────────────────────────
    const { models } = sequelize;
    const sessionId  = String(req.body.sessionId || `anon-${Date.now()}`);
    const turns      = safeHistory.length + 1;

    let outcome = 'no_action';
    if (otherActions.some((a) => a.type === 'redirect'))      outcome = 'checkout_redirect';
    else if (otherActions.some((a) => a.type === 'add_to_cart')) outcome = 'cart_add';
    else if (estadoActualizado.trackingSoporte?.ordenId)         outcome = 'support_query';

    const addedProducts = otherActions
      .filter((a) => a.type === 'add_to_cart')
      .map((a) => ({ id: a.productoId, qty: a.cantidad }));

    const toolCallNames = conversationMessages
      .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
      .flatMap((m) => m.tool_calls.map((tc) => tc.function.name));

    logSalesEvent(models, {
      sessionId,
      outcome,
      productIds:    addedProducts,
      turns,
      lastIntent:    message.trim(),
      toolCallNames,
    });
    // ─────────────────────────────────────────────────────────────────────────

    return res.json({
      message:           reply,
      products,
      actions:           otherActions,
      estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
    });
  } catch (err) {
    console.error('[NutrIA] Error inesperado:', err.message);
    return res.json({
      message:           '¡Chuta! Me distraje un momento, ¿probamos de nuevo? 🦦',
      products:          [],
      actions:           [],
      estadoActualizado: null,
    });
  }
});

// ── GET /api/v1/ai/stats ─────────────────────────────────────────────────────
// Requires admin JWT. Returns real chatbot conversion metrics.
// Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional)
router.get('/stats', passport.authenticate('jwt', { session: false }), checkRoles('admin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const { models }   = sequelize;

    const where = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to)   where.createdAt[Op.lte]  = new Date(to);
    }

    const rows = await models.SalesPerformance.findAll({ where, order: [['createdAt', 'DESC']] });

    const totals = { cart_add: 0, checkout_redirect: 0, support_query: 0, no_action: 0 };
    rows.forEach((r) => { if (totals[r.outcome] !== undefined) totals[r.outcome]++; });

    const meaningful   = totals.cart_add + totals.checkout_redirect + totals.support_query;
    const convRate     = meaningful > 0
      ? `${((totals.checkout_redirect / meaningful) * 100).toFixed(1)}%`
      : '0%';

    return res.json({
      period:                  { from: from ?? 'all', to: to ?? 'all' },
      total_sessions:          rows.length,
      meaningful_interactions: meaningful,
      conversion_rate:         convRate,
      totals,
    });
  } catch (err) {
    console.error('[NutrIA:stats]', err.message);
    return res.status(500).json({ message: 'Error al obtener estadísticas de ventas.' });
  }
});

// ── GET /api/v1/ai/telegram/debug ────────────────────────────────────────────
// Returns live webhook status from Telegram + local env/auto-discovery state.
// Hit this endpoint after deploy to confirm the webhook is registered correctly.
router.get('/telegram/debug', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return res.status(503).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN no configurado en Railway.' });
  }
  try {
    const tgRes  = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const tgData = await tgRes.json();
    return res.json({
      ok:           tgData.ok,
      webhook_info: tgData.result ?? null,
      local_state:  {
        TELEGRAM_OWNER_ID: process.env.TELEGRAM_OWNER_ID || null,
        TELEGRAM_CHAT_ID:  process.env.TELEGRAM_CHAT_ID  || null,
        detectedOwnerId:   detectedOwnerId               || null,
        ownerIdWarned,
      },
    });
  } catch (err) {
    console.error('[Telegram:debug]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/v1/ai/telegram/webhook ─────────────────────────────────────────
// Receives ALL Telegram bot updates (NutrIA alerts + Dropi 2FA failover).
// Returns 200 immediately — Telegram retries if we don't respond within 3 s.
router.post('/telegram/webhook', async (req, res) => {
  // Validate optional webhook secret (set when registering with Telegram).
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== expectedSecret) {
      console.warn('[Telegram Webhook] Rejected: invalid secret token.');
      return res.sendStatus(403);
    }
  }

  res.sendStatus(200); // ack before any async work

  const update = req.body;
  const msg    = update?.message ?? update?.channel_post ?? update?.edited_message;
  if (!msg?.chat?.id) return;

  const incomingId = String(msg.chat.id);
  const text       = (msg.text || '').trim();

  // Auto-discovery: capture the owner's chat_id on first message.
  if (!detectedOwnerId) {
    detectedOwnerId = incomingId;
  }

  if (!ownerIdWarned) {
    const configured = process.env.TELEGRAM_OWNER_ID;
    if (!configured || configured !== incomingId) {
      ownerIdWarned = true;
      console.warn(`[AUTO-CONFIG] First message from chat_id=${incomingId}. Set TELEGRAM_OWNER_ID=${incomingId} in Railway to make this permanent.`);
    }
  }

  // ── Dropi 2FA failover — CEO sends 6-digit code ───────────────────────────
  // Only process from the configured owner chat; ignore bots and groups.
  const allowedChatId = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_CHAT_ID;
  if (!allowedChatId || incomingId !== String(allowedChatId)) return;

  const codeMatch = text.match(/\b(\d{6})\b/);
  if (!codeMatch) return; // Not a 2FA code — NutrIA alert replies are ignored

  const code = codeMatch[1];
  console.log(`[Telegram Webhook] Código 2FA recibido del CEO (chat_id=${incomingId}): ${code}`);

  try {
    await completeManual2FA(code);
    await sendTelegram('✅ <b>Autenticación exitosa.</b>\n\nEl token de Dropi ha sido renovado. Las importaciones pueden continuar.');
    console.log('[Telegram Webhook] Login manual completado.');
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message || 'Error desconocido';
    await sendTelegram(`❌ <b>Error de autenticación.</b>\n\n${errMsg}\n\nVerifica el código e inténtalo de nuevo.`);
    console.error('[Telegram Webhook] Login manual fallido:', errMsg);
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

    const safeHistory = history
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-12);

    const completion = await safeGroqCall(groq, {
      model: MODEL_FALLBACK,
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

// ── POST /api/v1/ai/neuro-copy ────────────────────────────────────────────────
// SSE streaming endpoint — returns text/event-stream chunks so the dashboard
// can render the description word-by-word as the model generates it.
// Body: { name, description?, rawDetails?, variants? }
// Events: data: {"text":"chunk"}\n\n  →  event: done\ndata: {}\n\n
router.post(
  '/neuro-copy',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res) => {
    const { name, description, rawDetails, variants } = req.body ?? {};

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ message: 'Se requiere "name" con el nombre del producto.' });
    }

    // SSE headers — disable buffering at every proxy layer
    res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const groq = getGroqClient();
    if (!groq) {
      return res.status(503).json({ message: 'GROQ_API_KEY no configurada — agrega la variable en Railway.' });
    }

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
      const copyModel = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
      const stream = await groq.chat.completions.create(
        {
          model:      copyModel,
          messages: [
            { role: 'system', content: NEURO_SYSTEM_PROMPT },
            { role: 'user',   content: buildNeuroCopyUserContent({ name: name.trim(), description, rawDetails, variants }) },
          ],
          max_tokens: 650,
          stream:     true,
        },
        { signal: controller.signal }
      );

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const text = chunk.choices[0]?.delta?.content ?? '';
        if (text) send({ text });
      }

      if (!res.writableEnded) {
        res.write('event: done\ndata: {}\n\n');
        res.end();
        console.log(`[NeuroAI] Stream completado para "${name.trim()}"`);
      }
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) return;
      console.error('[NeuroAI] Error al iniciar stream:', err.message);
      if (!res.writableEnded) {
        send({ error: `GROQ_SERVICE_ERROR — ${err.message}` });
        res.end();
      }
    }
  },
);

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
