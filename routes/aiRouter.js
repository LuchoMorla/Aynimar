'use strict';
/* eslint-disable no-console */

const express  = require('express');
const passport = require('passport');
const OpenAI   = require('openai');
const { Op }   = require('sequelize');
const Joi      = require('joi');
const { checkRoles, optionalAuth } = require('../middlewares/authHandler');
const validatorHandler        = require('../middlewares/validatorHandler');
const { enqueueVideo }        = require('../libs/videoQueue');
const { newRef }              = require('../integrations/videoService');
const reviews                 = require('../Services/creativeReviewService');
const ctoInbox                = require('../Services/ctoInboxService');
const socialPub               = require('../Services/socialPublisherService');
const { callTelegram }        = require('../utils/telegramNotify');
const {
  optimizeProductCopy,
  NEURO_SYSTEM_PROMPT,
  buildNeuroCopyUserContent,
  validateCopyOutput,
  GROQ_MODEL_CHAIN,
  groqCreateWithFallback,
  isModelUnavailableError,
  stripReasoning,
} = require('../integrations/aiCopyService');
const { completeManual2FA }   = require('../integrations/dropi/dropiAuthService');
const sequelize               = require('../libs/sequelize');
const {
  getTelegramToken,
  getAdminChatId,
  isValidWebhookSecret,
  verifyCallbackQuery,
  maskId,
  isValidCtoKey,
} = require('../libs/telegramSecurity');

const router = express.Router();

// ── Groq client ───────────────────────────────────────────────────────────────
// PRIMARY handles complex reasoning turns (comparisons, neurosales analysis);
// FALLBACK handles routine sales chat and 429 spill-over. Both verified live on
// Groq 2026-09-08 with native tool-calling. If either is retired, safeGroqCall
// transparently walks GROQ_MODEL_CHAIN (see aiCopyService.js) so NutrIA stays up.
const MODEL_PRIMARY  = GROQ_MODEL_CHAIN.find((m) => m.includes('gpt-oss-120b')) || GROQ_MODEL_CHAIN[0];
const MODEL_FALLBACK = GROQ_MODEL_CHAIN[0];

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

// safeGroqCall: 70B→8B fallback on 429; throws RateLimitError when both models are saturated.
// Also transparently walks GROQ_MODEL_CHAIN when a model id is decommissioned/unknown,
// so a stale GROQ_MODEL env var never takes NutrIA offline.
async function safeGroqCall(groq, params) {
  try {
    return await groq.chat.completions.create(params);
  } catch (err) {
    if (isModelUnavailableError(err)) {
      for (const model of GROQ_MODEL_CHAIN) {
        if (model === params.model) continue;
        try {
          console.error(`[NutrIA] modelo "${params.model}" no disponible — reintentando con "${model}"`);
          return await groq.chat.completions.create({ ...params, model });
        } catch (e2) {
          if (isModelUnavailableError(e2)) continue;
          if (e2.status === 429 || e2.statusCode === 429) throw new RateLimitError();
          throw e2;
        }
      }
      throw err;
    }
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
// sendTelegram usa parse_mode HTML: todo texto que venga del usuario o del LLM
// pasa por escHtml (definido más abajo, sección F2) para no inyectar HTML.
// Priority: TELEGRAM_OWNER_ID → TELEGRAM_CHAT_ID. Sin auto-descubrimiento: el
// primer desconocido que escribiera al bot recibiría las alertas (F0).
async function sendTelegram(text) {
  const token  = getTelegramToken();
  const chatId = getAdminChatId();
  if (!token || !chatId) {
    console.warn('[NutrIA] Telegram no configurado (token/chat ausente o bloqueado en este entorno).');
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
// Also strips <think>…</think> chain-of-thought blocks: Qwen/reasoning models on
// Groq can emit them inline when the API doesn't split reasoning into its own field.
function sanitizeReply(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '') // unterminated (truncated) reasoning block
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
// Mismo origen que el permalink de routes/woocommerceMirror.js (enlaces del canal WhatsApp).
const STORE_URL = (process.env.NEXT_PUBLIC_FRONTEND_URL || 'https://www.aynimar.com').replace(/\/$/, '');
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
// ctx = { userId, role } del JWT de la conversación (optionalAuth); vacío si es anónimo.
// Canal WhatsApp (hub): solo productos visibles en la tienda (los enlaces /store/:id
// de un producto oculto no sirven al cliente). La web conserva su comportamiento.
const shopVisible = (channel) => (channel === 'whatsapp' ? { showShop: true } : {});

async function executeTool(name, args, clientActions, estadoActualizado, ctx = {}) {
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
        where: { [Op.or]: orClauses, isDeleted: false, ...shopVisible(ctx.channel) },
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
            where: { categoryId: { [Op.in]: catIds }, isDeleted: false, ...shopVisible(ctx.channel) },
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
      // IDOR: solo pedidos del usuario autenticado (admin, cualquiera). Anónimo o
      // ajeno → el mismo error que «no existe». La caché va por usuario+pedido.
      const notFound = { error: 'Pedido no encontrado. Verifica el número.' };
      // WhatsApp (hub): sesión siempre anónima ⇒ nunca por número; se remite a su cuenta.
      if (!ctx.userId && ctx.channel === 'whatsapp') {
        return { error: `Pedido no encontrado. Por WhatsApp no consulto pedidos por número: el cliente puede verlo en ${STORE_URL}/mi_cuenta/orders iniciando sesión, o con el enlace de seguimiento de su correo de confirmación.` };
      }
      if (!ctx.userId) return notFound;
      const cacheKey = `${ctx.userId}:${args.orden_id}`;
      const hit = cachedOrder(cacheKey);
      if (hit) {
        estadoActualizado.trackingSoporte = {
          ordenId: hit.id, estado: hit.estado, guia: hit.guia, transportista: hit.transportista,
        };
        return hit;
      }

      const order = await models.Order.findByPk(args.orden_id, {
        attributes: ['id', 'state', 'stateOrder', 'createdAt', 'trackingNumber', 'carrierName'],
        include: [{ association: 'customer', attributes: ['userId'] }],
      });
      if (!order) return notFound;
      if (ctx.role !== 'admin' && Number(order.customer?.userId) !== Number(ctx.userId)) return notFound;

      const result = {
        id:            order.id,
        estado:        order.state,
        detalle:       order.stateOrder,
        guia:          order.trackingNumber ?? null,
        transportista: order.carrierName    ?? null,
        creado:        order.createdAt,
      };
      cacheOrder(cacheKey, result);
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
    const sent   = await sendTelegram(`${emoji} <b>${titulo}</b>\n\n${escHtml(args.mensaje.slice(0, 1500))}`);

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
      const id = Number(args.producto_id);
      const product = Number.isSafeInteger(id) && id > 0
        ? await models.Product.findOne({
            where: { id, isDeleted: false, ...shopVisible(ctx.channel) },
            attributes: ['id', 'name', 'price', 'stock', 'description', 'image'],
          })
        : null;
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

// ── Motor de NutrIA (un turno) ────────────────────────────────────────────────
// Compartido por POST /nutria/chat (web) y la entrada del hub WhatsApp
// (routes/hubRouter.js). input = { message, history, contexto, sessionId, user?, channel? };
// `user` = JWT ({ sub, role }) o vacío (anónimo); `groq` = cliente OpenAI-compatible
// (inyectable en tests). Devuelve { body, toolCallNames }: body es EXACTAMENTE la
// respuesta JSON de /nutria/chat.
const NUTRIA_WHATSAPP_NOTE = `

━━━ CANAL WHATSAPP ━━━
Hablas por WhatsApp: no hay tarjetas ni botones. El servidor añade los enlaces a la ficha de cada producto y,
cuando usas agregar_al_carrito o redirigir_checkout, un enlace de compra con el carrito. No escribas URLs.
Por este canal NO se consultan pedidos por número: si preguntan por un pedido, indica revisarlo en su cuenta de la tienda.`;

async function runNutriaTurn({ message, history, contexto, sessionId, user, channel } = {}, groq) {
  // Pick model based on message complexity; 8B handles most sales chats
  const model = process.env.GROQ_MODEL || pickModel(message.trim());

  // Últimos 6 mensajes, máx. 2000 caracteres cada uno (endpoint público:
  // sin tope, un historial enorme dispara coste/latencia del LLM).
  const safeHistory = Array.isArray(history)
    ? history
        .filter(
          (m) => m && typeof m.role === 'string' && typeof m.content === 'string'
            && ['user', 'assistant'].includes(m.role)
        )
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
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
          where: { [Op.or]: orClauses, isDeleted: false, ...shopVisible(channel) },
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

  const systemContent = NUTRIA_SYSTEM_PROMPT + (channel === 'whatsapp' ? NUTRIA_WHATSAPP_NOTE : '') + contextNarrative + oportunidadStr;

  const conversationMessages = [
    { role: 'system', content: systemContent },
    ...safeHistory,
    { role: 'user',   content: message.trim() },
  ];

  const groqParams = { model, messages: conversationMessages, tools: NUTRIA_TOOLS, tool_choice: 'auto' };
  const toolNames  = () => conversationMessages
    .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    .flatMap((m) => m.tool_calls.map((tc) => tc.function.name));

  // ── First Groq call (with 70B→8B fallback on 429) ────────────────────────
  let completion;
  try {
    completion = await safeGroqCall(groq, groqParams);
  } catch (groqInitErr) {
    if (groqInitErr.isRateLimit) {
      await new Promise((r) => setTimeout(r, 5000));
      return { toolCallNames: toolNames(), body: {
        message:           '¡Chuta! Dame un segundo que el sistema está procesando a máxima velocidad, ya te doy el precio. 🦦',
        products:          [],
        actions:           clientActions.filter((a) => a.type !== 'show_products'),
        estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
      } };
    }
    console.error('[NutrIA] Groq initial call failed:', groqInitErr.message);
    return { toolCallNames: toolNames(), body: {
      message:           '¡Chuta! Me distraje un momento. ¿Lo intentamos de nuevo? 🦦',
      products:          [],
      actions:           clientActions.filter((a) => a.type !== 'show_products'),
      estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
    } };
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
          result = await executeTool(tc.function.name, args, clientActions, estadoActualizado, { userId: user?.sub, role: user?.role, channel });
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
        return { toolCallNames: toolNames(), body: {
          message:           '¡Chuta! Dame un segundo que el sistema está procesando a máxima velocidad, ya te doy el precio. 🦦',
          products:          clientActions.filter((a) => a.type === 'show_products').flatMap((a) => a.productos ?? []),
          actions:           clientActions.filter((a) => a.type !== 'show_products'),
          estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
        } };
      }
      console.error('[NutrIA] Groq loop error:', groqLoopErr.message);
      return { toolCallNames: toolNames(), body: {
        message:           '¡Chuta! Me distraje buscando, ¿probamos con otro término? 🦦',
        products:          clientActions.filter((a) => a.type === 'show_products').flatMap((a) => a.productos ?? []),
        actions:           clientActions.filter((a) => a.type !== 'show_products'),
        estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
      } };
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
  const sid        = String(sessionId || `anon-${Date.now()}`);
  const turns      = safeHistory.length + 1;

  let outcome = 'no_action';
  if (otherActions.some((a) => a.type === 'redirect'))      outcome = 'checkout_redirect';
  else if (otherActions.some((a) => a.type === 'add_to_cart')) outcome = 'cart_add';
  else if (estadoActualizado.trackingSoporte?.ordenId)         outcome = 'support_query';

  const addedProducts = otherActions
    .filter((a) => a.type === 'add_to_cart')
    .map((a) => ({ id: a.productoId, qty: a.cantidad }));

  const toolCallNames = toolNames();

  logSalesEvent(models, {
    sessionId:     sid,
    outcome,
    productIds:    addedProducts,
    turns,
    lastIntent:    message.trim(),
    toolCallNames,
  });
  // ─────────────────────────────────────────────────────────────────────────

  return { toolCallNames, body: {
    message:           reply,
    products,
    actions:           otherActions,
    estadoActualizado: Object.keys(estadoActualizado).length > 0 ? estadoActualizado : null,
  } };
}

// ── POST /api/v1/ai/nutria/chat ───────────────────────────────────────────────
// Accepts: { message: string, history: array, contexto: object }
// Returns: { reply: string, actions: array, estadoActualizado: object }
router.post('/nutria/chat', optionalAuth, async (req, res) => {
  try {
    const { message, history, contexto } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ message: 'Se requiere el campo "message".' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ message: 'El mensaje es demasiado largo (máx. 2000 caracteres).' });
    }

    const groq = router.llm || getGroqClient(); // router.llm: LLM simulado en tests
    if (!groq) {
      console.error('[NutrIA] GROQ_IA_KEY no configurada.');
      return res.status(503).json({ message: 'NutrIA está en mantenimiento. Vuelve pronto 🦦.' });
    }

    const { body } = await runNutriaTurn({ message, history, contexto, sessionId: req.body.sessionId, user: req.user }, groq);
    return res.json(body);
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

// ── POST /api/v1/ai/videos ───────────────────────────────────────────────────
// Admin. Encola el render de un vídeo 9:16 con fotos reales y lo envía a
// Telegram para revisión. benefit lo escribe el dueño (no LLM). Responde 202.
const videoSchema = Joi.object({
  productId: Joi.number().integer().positive().required(),
  variant:   Joi.string().valid('v1', 'v2', 'v3').required(),
  benefit:   Joi.string().trim().min(3).max(60).required(),
  network:   Joi.string().valid('instagram', 'tiktok', 'facebook').default('instagram'),
});
router.post('/videos', passport.authenticate('jwt', { session: false }), checkRoles('admin'), validatorHandler(videoSchema, 'body'), async (req, res) => {
  const { value } = videoSchema.validate(req.body);
  const ref = newRef(value.productId);
  try {
    const { mode } = await enqueueVideo({ ...value, ref });
    return res.status(202).json({ queued: true, ref, mode });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ message: 'Ya hay vídeos en cola; inténtalo en unos minutos.' });
    console.error('[Video] no se pudo encolar:', err.message);
    return res.status(503).json({ message: 'No se pudo encolar el vídeo.' });
  }
});

// ── GET /api/v1/ai/telegram/debug ────────────────────────────────────────────
// Returns live webhook status from Telegram. Admin-only (F0): antes era público
// y exponía el chat_id del CEO. Los ids se devuelven enmascarados.
router.get('/telegram/debug', passport.authenticate('jwt', { session: false }), checkRoles('admin'), async (req, res) => {
  const token = getTelegramToken();
  if (!token) {
    return res.status(503).json({ ok: false, error: 'Telegram no configurado o bloqueado en este entorno.' });
  }
  try {
    const tgRes  = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const tgData = await tgRes.json();
    const info   = tgData.result ?? {};
    return res.json({
      ok:           tgData.ok,
      webhook_info: {
        url:                  info.url ?? null,
        pending_update_count: info.pending_update_count ?? null,
        last_error_date:      info.last_error_date ?? null,
        last_error_message:   info.last_error_message ?? null,
        allowed_updates:      info.allowed_updates ?? null,
      },
      local_state:  {
        admin_chat_id:      maskId(getAdminChatId()),
        webhook_secret_set: !!process.env.TELEGRAM_WEBHOOK_SECRET,
      },
    });
  } catch (err) {
    console.error('[Telegram:debug] getWebhookInfo falló:', err.name);
    return res.status(502).json({ ok: false, error: 'No se pudo consultar Telegram.' });
  }
});

// ── GET /api/v1/ai/cto/inbox?after=<id> ─────────────────────────────────────
// Respuestas del propietario a preguntas del CTO (scripts/cto-ask.js).
// Header X-CTO-Key = HMAC-SHA256(TELEGRAM_WEBHOOK_SECRET, 'aynimar-cto-inbox-v1') hex.
router.get('/cto/inbox', async (req, res) => {
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(503).json({ ok: false });
  if (!isValidCtoKey(req.get('x-cto-key'))) return res.status(403).json({ ok: false });
  const after = req.query.after === undefined ? 0 : Number(req.query.after);
  if (!Number.isInteger(after) || after < 0) return res.status(400).json({ ok: false });
  try {
    return res.json({ ok: true, entries: await ctoInbox.listAfter(after) });
  } catch (err) {
    console.error('[CTO] no se pudo leer el buzón:', err.name);
    return res.status(500).json({ ok: false });
  }
});

// Responde a un callback_query (quita el "reloj" del botón). Nunca lanza.
async function answerCallback(callbackQueryId, text) {
  const token = getTelegramToken();
  if (!token || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch (err) {
    console.error('[Telegram Webhook] answerCallbackQuery falló:', err.name);
  }
}

// ── F2: revisión de piezas desde Telegram ────────────────────────────────────
// "Aprobar" NO publica en redes: marca la pieza y envía el kit de publicación manual.
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function adminMessage(text, extra = {}) {
  return callTelegram('sendMessage', { chat_id: getAdminChatId(), text, ...extra });
}

function publishKit(r) {
  const net = escHtml(r.network || 'la red');
  return `📦 <b>KIT DE PUBLICACIÓN</b>\nRef: ${escHtml(r.ref)} · ${net}\n\n` +
    `<b>1. Texto para copiar</b> (tócalo para copiarlo):\n<pre>${escHtml(r.caption)}</pre>\n\n` +
    `<b>2. Link con UTM</b>:\n${escHtml(r.utmLink)}\n\n` +
    `Coste de producción: ${r.productionCostUsd == null ? 'desconocido' : `$${Number(r.productionCostUsd).toFixed(4)}`}\n\n` +
    `<b>3. Pasos manuales</b>\n` +
    `• Abre el vídeo de este chat → ⋮ → Guardar / Descargar.\n` +
    `• Publícalo en ${net} y pega el texto del punto 1.\n` +
    `• Si la red no hace clicables los links del texto, pon el link en la bio o en una historia con enlace.\n\n` +
    `Nada se publica automáticamente.`;
}

async function handleReviewCallback(cq, { action, ref }) {
  let result;
  // Refs 's<pieza>x…' = paquete del publicador social (vídeo + redes + textos + horarios).
  const isPackage = socialPub.isPackageRef(ref);
  try {
    result = isPackage ? await socialPub.decidePackage(ref, action, cq.from.id) : await reviews.decide(ref, action, cq.from.id);
  } catch (err) {
    console.error(`[Telegram Webhook] no se pudo registrar la decisión de ${ref}: ${err.name}`);
    await answerCallback(cq.id, '⚠️ No se pudo registrar la decisión. Inténtalo de nuevo.');
    return;
  }
  const { changed, review } = result;
  if (!review) {
    console.warn(`[Telegram Webhook] callback para pieza inexistente ${ref}.`);
    await answerCallback(cq.id, 'Pieza no encontrada.');
    return;
  }
  const label = reviews.STATUS_LABEL[review.status] || review.status;
  if (result.stale || result.superseded) {
    console.warn(`[Telegram Webhook] ${ref} paquete modificado/reenviado; aprobación no aplicada.`);
    await answerCallback(cq.id, '⚠️ El paquete cambió: necesita una nueva revisión.');
    if (result.stale) await adminMessage(`⚠️ Ref: ${ref}\nEl paquete cambió después de enviarse (texto, red, horario o vídeo). No se aprobó ni se encoló nada. Reenvíalo a revisión.`);
    return;
  }
  if (!changed) {
    console.log(`[Telegram Webhook] ${ref} ya decidida (${review.status}); sin cambios.`);
    await answerCallback(cq.id, `Ya decidido: ${label}`);
    return;
  }
  console.log(`[Telegram Webhook] ${ref} → ${review.status}`);
  await answerCallback(cq.id, label);

  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const replyTo = messageId ? { reply_to_message_id: messageId } : {};
  if (chatId && messageId) {
    // Quitar botones (evita doble clic) y añadir el estado al caption; si no se
    // puede editar, el estado va como respuesta al vídeo.
    await callTelegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    const edited = cq.message.text != null
      ? await callTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `${String(cq.message.text).slice(0, 3900)}\n\nEstado: ${label}`, reply_markup: { inline_keyboard: [] } })
      : await callTelegram('editMessageCaption', { chat_id: chatId, message_id: messageId, caption: `${String(cq.message.caption || '').slice(0, 960)}\n\nEstado: ${label}`, reply_markup: { inline_keyboard: [] } });
    if (!edited) await adminMessage(`Estado de ${ref}: ${label}`, replyTo);
  }

  if (review.status === 'approved' && isPackage) await packageApproved(ref, result, replyTo);
  else if (review.status === 'approved') await adminMessage(publishKit(review), { parse_mode: 'HTML', ...replyTo });
  else if (review.status === 'rejected') await adminMessage(`❌ Ref: ${ref} rechazada. No se publicará.\nSi quieres, responde a este mensaje con el motivo.`, replyTo);
  else await adminMessage(`✏️ Ref: ${ref}\nResponde (Responder) a este mensaje o al vídeo con los cambios que quieres.`, replyTo);
}

/** Paquete aprobado: resumen de lo encolado y kit manual de las redes con vía manual. */
async function packageApproved(ref, { queued, manual }, replyTo) {
  const line = (p) => `• ${p.network} (${p.channel}) — ${socialPub.localTime(p.scheduled_at, p.timezone)}`;
  const enabled = await socialPub.isEnabled().catch(() => false);
  await adminMessage(`✅ Ref: ${ref} aprobado.\nProgramadas (${queued.length}):\n${queued.map(line).join('\n') || '—'}\n` +
    `Manuales (${manual.length}):\n${manual.map(line).join('\n') || '—'}\n\nPublicación automática: ${enabled ? 'ON' : 'OFF — /reanudar para activarla'}.`, replyTo);
  for (const p of manual) {
    await adminMessage(publishKit({ ref, network: p.network, caption: p.caption, utmLink: p.utm_link, productionCostUsd: null }), { parse_mode: 'HTML', ...replyTo });
  }
}

/** true si el texto se guardó como cambios de una pieza en changes_requested. */
async function saveChangeRequestSafe(ref, text, messageId) {
  try {
    if (!(await reviews.saveChangeRequest(ref, text))) return false;
  } catch (err) {
    console.error(`[Telegram Webhook] no se pudieron guardar los cambios de ${ref}: ${err.name}`);
    await adminMessage(`⚠️ No se pudieron guardar los cambios de ${ref}. Inténtalo de nuevo.`, { reply_to_message_id: messageId });
    return true;
  }
  console.log(`[Telegram Webhook] cambios guardados para ${ref}.`);
  await adminMessage(`📝 Cambios guardados para ${ref}.`, { reply_to_message_id: messageId });
  return true;
}

async function handleAdminCommand(cmd) {
  try {
    if (cmd === 'estado') {
      const [rows, social, publisher, queue] = await Promise.all([reviews.latest(10), reviews.isSocialEnabled(), socialPub.isEnabled().catch(() => false), socialPub.queueSummary().catch(() => 'no disponible')]);
      const lines = rows.map((r) => `• ${r.ref} · producto ${r.productId} · ${r.variant || '-'} · ${r.network || '-'} — ${reviews.STATUS_LABEL[r.status] || r.status}`);
      await adminMessage(`Últimas piezas:\n${lines.join('\n') || '(ninguna)'}\n\nInterruptor de publicación (${reviews.SOCIAL_KEY}): ${social ? 'ON' : 'OFF'}\nPublicador social (${socialPub.PUBLISHER_KEY}): ${publisher ? 'ON' : 'OFF'}\nCola social: ${queue}`);
      return;
    }
    // /start lo envía Telegram al abrir el bot: no puede encender la publicación.
    const enabled = cmd === 'reanudar';
    await Promise.all([reviews.setSocialEnabled(enabled), socialPub.setEnabled(enabled)]);
    console.log(`[Social] interruptor de publicación → ${enabled ? 'ON' : 'OFF'} (admin vía Telegram).`);
    await adminMessage(`Interruptor de publicación: ${enabled ? 'ON' : 'OFF'}.\n${enabled
      ? 'Solo se publican paquetes aprobados, en redes de la lista blanca y con credenciales configuradas.'
      : 'Pausa global: el worker no publicará nada (lo programado queda en cola).'}`);
  } catch (err) {
    console.error(`[Telegram Webhook] comando /${cmd} falló: ${err.name}`);
    await adminMessage(`⚠️ No se pudo ejecutar /${cmd}.`);
  }
}

// ── POST /api/v1/ai/telegram/webhook ─────────────────────────────────────────
// Receives ALL Telegram bot updates (NutrIA alerts + Dropi 2FA failover).
// Returns 200 immediately — Telegram retries if we don't respond within 3 s.
router.post('/telegram/webhook', async (req, res) => {
  // F0: secreto OBLIGATORIO (fail-closed). Sin TELEGRAM_WEBHOOK_SECRET en el
  // entorno, o con header ausente/incorrecto, la petición se rechaza.
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.error('[Telegram Webhook][CRITICAL] TELEGRAM_WEBHOOK_SECRET no configurado — update rechazado.');
    return res.sendStatus(503);
  }
  if (!isValidWebhookSecret(req.headers['x-telegram-bot-api-secret-token'])) {
    console.warn('[Telegram Webhook] Rejected: secret token ausente o inválido.');
    return res.sendStatus(403);
  }

  res.sendStatus(200); // ack before any async work

  const update = req.body;

  // ── callback_query — aprobaciones F2 ──────────────────────────────────────
  // Nunca se aprueba por texto libre. Un callback solo es válido si viene del
  // admin, en su chat, con callback_data firmado (libs/telegramSecurity.js).
  if (update?.callback_query) {
    const cq      = update.callback_query;
    const verdict = verifyCallbackQuery(cq);
    if (!verdict.ok) {
      console.warn(`[Telegram Webhook] callback_query rechazado: ${verdict.reason}`);
      await answerCallback(cq.id, '⛔ Acción no válida.');
      return;
    }
    if (verdict.action === 'cq') await ctoInbox.handleCallback(cq, verdict.ref);
    // Ref o<id> = confirmación de envío de un pedido a Dropi (modo supervisado).
    else if (/^o\d+$/.test(verdict.ref)) {
      await require('../Services/orderAutomationService').handleTelegramCallback(cq, verdict, answerCallback)
        .catch((err) => console.error(`[Telegram Webhook] confirmación de pedido ${verdict.ref} falló: ${err.name}`));
      return;
    }
    else await handleReviewCallback(cq, verdict);
    return;
  }

  const msg    = update?.message ?? update?.channel_post ?? update?.edited_message;
  if (!msg?.chat?.id) return;

  const incomingId = String(msg.chat.id);
  const text       = (msg.text || '').trim();

  // ── Dropi 2FA failover — CEO sends 6-digit code ───────────────────────────
  // Only process from the configured owner chat; ignore bots and groups.
  const allowedChatId = getAdminChatId();
  if (!allowedChatId || incomingId !== String(allowedChatId)) return;

  // ── F2: comandos y respuestas de cambios (solo mensajes nuevos del admin) ──
  // Un texto que sea SOLO 6 dígitos nunca se trata como cambios: va al 2FA.
  if (update.message && String(msg.from?.id) === String(allowedChatId)) {
    const cmd = /^\/(estado|stop|reanudar)(?:@\w+)?$/i.exec(text);
    if (cmd) { await handleAdminCommand(cmd[1].toLowerCase()); return; }
    const replied = msg.reply_to_message;
    if (replied?.from?.is_bot && text && !/^\d{6}$/.test(text)) {
      const qid = ctoInbox.questionId(replied.text || replied.caption);
      if (qid) { await ctoInbox.handleReply(msg, qid, text); return; }
      const ref = /Ref: ([A-Za-z0-9_-]{1,32})/.exec(replied.caption || replied.text || '')?.[1];
      if (ref && await saveChangeRequestSafe(ref, text, msg.message_id)) return;
    }
  }

  const codeMatch = text.match(/\b(\d{6})\b/);
  if (!codeMatch) return; // Not a 2FA code — NutrIA alert replies are ignored

  const code = codeMatch[1];
  console.log('[Telegram Webhook] Código 2FA recibido del admin.'); // el código OTP no se registra

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

    // Tope: 12 mensajes × 1000 caracteres (petición pública, sin auth).
    const safeHistory = history
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));

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

    // El análisis lo genera el LLM a partir de texto del usuario: se escapa
    // (parse_mode HTML) y se acota cada campo.
    const f    = (v, n = 80) => escHtml(String(v ?? 'n/a').slice(0, n));
    const list = (v, empty) => (Array.isArray(v) ? v.slice(0, 8).map((x) => f(x)).join(', ') : '') || empty;
    const msg =
      `📊 <b>Reporte de Sesión NutrIA</b>\n\n` +
      `😟 Emoción inicial: <b>${f(analysis.emocion_inicial)}</b>\n` +
      `😊 Emoción final:   <b>${f(analysis.emocion_final)}</b>\n` +
      `⚡ Interés:          <b>${f(analysis.nivel_interes, 4)}/10</b>\n` +
      `🛍 Productos: ${list(analysis.productos_mencionados, 'ninguno')}\n` +
      `🔧 Fricción:  ${list(analysis.puntos_friccion, 'ninguna')}\n` +
      `✅ Resultado: <b>${f(analysis.resultado, 30)}</b>`;

    await sendTelegram(msg);
    return res.json({ ok: true, analysis });
  } catch (err) {
    console.error('[NutrIA:session-close]', err.message);
    return res.json({ ok: true });
  }
});

// ── POST /api/v1/ai/save-feedback ────────────────────────────────────────────
// Saves an approved/edited copy text as a style reference for future generations.
// Called automatically after product creation if AI copy was used.
// Body: { productId?, productName, categoryId?, approvedText }
router.post(
  '/save-feedback',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res) => {
    try {
      const { productId, productName, categoryId, approvedText } = req.body ?? {};

      if (!approvedText || typeof approvedText !== 'string' || approvedText.trim().length < 20) {
        return res.status(400).json({ message: '"approvedText" debe tener al menos 20 caracteres.' });
      }

      const { models } = sequelize;

      // If productId is given but productName wasn't passed, fetch it from the DB.
      let resolvedName   = productName ?? null;
      let resolvedCatId  = categoryId  != null ? parseInt(categoryId, 10)  : null;

      if (productId && !resolvedName) {
        const product = await models.Product.findByPk(parseInt(productId, 10), {
          attributes: ['name', 'categoryId'],
        }).catch(() => null);
        if (product) {
          resolvedName  = product.name;
          resolvedCatId = resolvedCatId ?? product.categoryId ?? null;
        }
      }

      const row = await models.AiCopyFeedback.create({
        productId:    productId ? parseInt(productId, 10) : null,
        productName:  resolvedName,
        categoryId:   resolvedCatId,
        approvedText: approvedText.trim(),
      });

      console.log(`[NeuroAI] Feedback guardado id=${row.id} producto="${resolvedName}" cat=${resolvedCatId}`);
      return res.json({ ok: true, feedbackId: row.id });
    } catch (err) {
      console.error('[NeuroAI:save-feedback]', err.message);
      return res.status(500).json({ message: 'Error al guardar el feedback.' });
    }
  }
);

// ── POST /api/v1/ai/neuro-copy ────────────────────────────────────────────────
// SSE streaming endpoint — returns text/event-stream chunks so the dashboard
// can render the description word-by-word as the model generates it.
// Body: { name, description?, rawDetails?, variants?, productId?, categoryId? }
// Events: data: {"text":"chunk"}\n\n  →  event: done\ndata: {}\n\n
router.post(
  '/neuro-copy',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  async (req, res) => {
    const { name, description, rawDetails, variants, productId, categoryId } = req.body ?? {};

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ message: 'Se requiere "name" con el nombre del producto.' });
    }

    // ── Fetch approved style examples from the feedback table ─────────────────
    // Priority: exact productId match → productName iLike → categoryId fallback.
    // Limit 2 examples to stay within prompt budget (~600 tokens for examples).
    let approvedExamples = [];
    try {
      const { models } = sequelize;
      const { Op: SeqOp } = require('sequelize');
      const whereOr = [];
      if (productId) whereOr.push({ productId: parseInt(productId, 10) });
      if (name.trim()) whereOr.push({ productName: { [SeqOp.iLike]: `%${name.trim()}%` } });
      if (categoryId) whereOr.push({ categoryId: parseInt(categoryId, 10) });

      if (whereOr.length > 0) {
        const rows = await models.AiCopyFeedback.findAll({
          where: { [SeqOp.or]: whereOr },
          order: [['createdAt', 'DESC']],
          limit: 2,
          attributes: ['approvedText'],
        });
        approvedExamples = rows.map((r) => r.approvedText);
        if (approvedExamples.length > 0) {
          console.log(`[NeuroAI] ${approvedExamples.length} ejemplo(s) aprobado(s) inyectado(s) al prompt`);
        }
      }
    } catch (fbErr) {
      console.warn('[NeuroAI] No se pudo consultar feedback:', fbErr.message);
    }

    // Check Groq client BEFORE flushing SSE headers — once 200 is committed we can't send HTTP errors.
    const groq = getGroqClient();
    if (!groq) {
      const keyState = process.env.GROQ_API_KEY ? 'GROQ_API_KEY presente' : (process.env.GROQ_IA_KEY ? 'GROQ_IA_KEY presente' : 'NINGUNA KEY');
      console.error(`[NeuroAI] getGroqClient() retornó null — estado de keys: ${keyState}`);
      return res.status(503).json({ message: 'GROQ_API_KEY no configurada — agrega la variable en Railway.' });
    }

    const copyModel = GROQ_MODEL_CHAIN.join(' → '); // for logs only — real pick happens in groqCreateWithFallback
    const keySource = process.env.GROQ_API_KEY ? 'GROQ_API_KEY' : 'GROQ_IA_KEY(fallback)';

    // ── ?stream=0 — non-streaming fallback (prueba de fuego) ─────────────────
    // If text appears in the JSON response, the backend works and the problem is buffering.
    if (req.query.stream === '0') {
      try {
        console.log(`[NeuroAI] NON-STREAM mode — producto: "${name.trim()}" | cadena: ${copyModel} | key: ${keySource}`);
        const { completion, model: usedModel } = await groqCreateWithFallback(groq, {
          messages: [
            { role: 'system', content: NEURO_SYSTEM_PROMPT },
            { role: 'user',   content: buildNeuroCopyUserContent({ name: name.trim(), description, rawDetails, variants, approvedExamples }) },
          ],
          max_tokens: 650,
        });
        const text = stripReasoning(completion.choices[0]?.message?.content ?? null);
        console.log(`[NeuroAI] NON-STREAM modelo usado: ${usedModel}`);
        console.log(`[NeuroAI] NON-STREAM completado — ${text?.length ?? 0} chars`);
        if (!text) return res.status(502).json({ message: 'Groq no devolvió contenido.' });
        const qvNonStream = validateCopyOutput(text);
        if (!qvNonStream.ok) {
          console.error(`[NeuroAI] QUALITY GATE FAIL (non-stream) — "${name.trim()}" — motivo: ${qvNonStream.reason} | preview: ${text.slice(0, 120)}`);
          return res.status(422).json({ message: `Copy rechazado por control de calidad: ${qvNonStream.reason}. Regenera el copy.` });
        }
        return res.json({ text });
      } catch (err) {
        console.error('[NeuroAI] NON-STREAM error:', err.message);
        return res.status(502).json({ message: `Error Groq: ${err.message}` });
      }
    }

    // ── SSE streaming path ────────────────────────────────────────────────────
    res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // res.flush() is injected by the `compression` middleware. This server does NOT
    // use compression, so this is a no-op — kept for future compatibility if
    // compression is added. Railway's proxy buffering must be handled upstream.
    const flush = () => { if (typeof res.flush === 'function') res.flush(); };

    // SSE comment ping — may break proxy buffer before real data arrives.
    res.write(': connected\n\n');
    flush();

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      flush();
    };

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
      console.log(`[NeuroAI] Stream iniciado — producto: "${name.trim()}" | cadena: ${copyModel} | key: ${keySource}`);
      const { completion: stream, model: usedModel } = await groqCreateWithFallback(
        groq,
        {
          messages: [
            { role: 'system', content: NEURO_SYSTEM_PROMPT },
            { role: 'user',   content: buildNeuroCopyUserContent({ name: name.trim(), description, rawDetails, variants, approvedExamples }) },
          ],
          max_tokens: 650,
          stream:     true,
        },
        { signal: controller.signal }
      );
      console.log(`[NeuroAI] Stream modelo usado: ${usedModel}`);

      let chunkCount = 0;
      let assembledText = '';
      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const text = chunk.choices[0]?.delta?.content ?? '';
        if (text) {
          chunkCount++;
          assembledText += text;
          console.log(`[NeuroAI] chunk #${chunkCount} (${text.length} chars) → ${JSON.stringify(text.slice(0, 30))}`);
          send({ text });
        }
      }
      console.log(`[NeuroAI] Stream loop terminado — total chunks: ${chunkCount}`);

      // Quality gate on the fully assembled output.
      // Cannot un-send SSE chunks, so we emit a warning event that the dashboard uses
      // to show a "Regenerar" alert without blocking the display of the generated copy.
      if (assembledText) {
        const qv = validateCopyOutput(stripReasoning(assembledText));
        if (!qv.ok) {
          console.error(`[NeuroAI] QUALITY GATE FAIL (stream) — "${name.trim()}" — motivo: ${qv.reason} | preview: ${assembledText.slice(0, 120)}`);
          if (!res.writableEnded) {
            res.write(`event: quality_warning\ndata: ${JSON.stringify({ reason: qv.reason })}\n\n`);
            flush();
          }
        }
      }

      if (!res.writableEnded) {
        res.write('event: done\ndata: {}\n\n');
        flush();
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
module.exports.executeTool = executeTool; // tests (order-idor-test) sin LLM
module.exports.runNutriaTurn = runNutriaTurn; // hub WhatsApp (routes/hubRouter.js)
module.exports.getGroqClient = getGroqClient;
module.exports.STORE_URL = STORE_URL;
