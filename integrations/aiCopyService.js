'use strict';

const OpenAI = require('openai');

// GROQ_API_KEY is the dedicated key for copy/import endpoints.
// Falls back to GROQ_IA_KEY so NutrIA and aiCopyService share one key if preferred.
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROQ_IA_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL   || 'llama-3.1-8b-instant';

// Startup diagnostic — visible in Railway logs on every deploy/restart.
const _keySource = process.env.GROQ_API_KEY
  ? 'GROQ_API_KEY ✓'
  : (process.env.GROQ_IA_KEY ? 'GROQ_IA_KEY (fallback) ✓' : 'NO CONFIGURADA ✗');
console.log(`[aiCopyService] Groq key: ${_keySource} | model: ${GROQ_MODEL}`);

function getGroqClient() {
  if (!GROQ_API_KEY) return null;
  return new OpenAI({ apiKey: GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
}

// ── Internal Groq chat helper (non-streaming) ─────────────────────────────────
async function groqChat(messages, { max_tokens = 600 } = {}) {
  const groq = getGroqClient();
  if (!groq) throw new Error('GROQ_API_KEY no configurada en Railway');
  const completion = await groq.chat.completions.create({ model: GROQ_MODEL, messages, max_tokens });
  return completion.choices[0]?.message?.content ?? null;
}

// ── Copy quality guard ────────────────────────────────────────────────────────
// Detects unfilled prompt-template placeholders that leak into the output.
// Pattern: [UppercaseSpanish text with 7+ chars] NOT followed by ( — excludes markdown links.
// Both generateProductCopy and neuroCopyProduct prompts prohibit brackets in output.
function _hasBracketLeak(text) {
  if (!text || typeof text !== 'string') return false;
  return /\[[A-Za-záéíóúüñÁÉÍÓÚÜÑ][^\]\n]{6,}\](?!\()/.test(text);
}

// Exposed for smoke tests and external validation.
function validateCopyOutput(text) {
  if (!text || text.trim().length < 10) return { ok: false, reason: 'EMPTY_OUTPUT' };
  if (_hasBracketLeak(text)) return { ok: false, reason: 'BRACKET_LEAK' };
  return { ok: true };
}

// ── generateProductCopy ───────────────────────────────────────────────────────
// Called by importRouter during Dropi product import.
// Returns null on failure — import continues without AI copy.
async function generateProductCopy(name, rawDescription) {
  const hasRealData = rawDescription && rawDescription.trim().length > 10;

  const messages = [
    {
      role: 'system',
      content:
        'Eres un experto en copywriting de alta conversión para e-commerce latinoamericano.\n' +
        'Tu única fuente de verdad son los datos reales que te proporciona el proveedor Dropi.\n' +
        'REGLA ABSOLUTA: NO inventes especificaciones, dimensiones, materiales, garantías ni compatibilidades.\n' +
        'Tu trabajo es TRANSFORMAR esa data técnica usando las técnicas AIDA y PAS.\n' +
        'Si un dato no está en la fuente, NO lo incluyas.',
    },
    {
      role: 'user',
      content:
        `Datos reales del producto de Dropi:\nNOMBRE: ${name}\n` +
        (hasRealData ? `DESCRIPCIÓN ORIGINAL DEL PROVEEDOR:\n${rawDescription}` : '(Sin descripción adicional del proveedor)') +
        '\n\nReescribe en Markdown con EXACTAMENTE estos 4 bloques, usando SOLO la información real:\n\n' +
        '## [Título comercial persuasivo]\n\n' +
        '[Párrafo corto de gancho basado en la utilidad real]\n\n' +
        '### ✅ Beneficios Clave\n' +
        '- **[Característica real 1]:** [Beneficio orientado al cliente]\n' +
        '- **[Característica real 2]:** [Beneficio orientado al cliente]\n' +
        '- **[Característica real 3]:** [Beneficio orientado al cliente]\n\n' +
        '### ❓ Preguntas Frecuentes\n\n' +
        '**¿[Pregunta lógica]?**\n[Respuesta con datos reales]\n\n' +
        '**¿[Pregunta de uso]?**\n[Respuesta honesta]\n\n' +
        'IMPORTANTE: omite bloques si no tienes datos suficientes. Responde SOLO con el Markdown.',
    },
  ];

  try {
    const text = await groqChat(messages, { max_tokens: 600 });
    const validation = validateCopyOutput(text);
    if (!validation.ok) {
      console.error(`[AI Copy] OUTPUT RECHAZADO para "${name}" — motivo: ${validation.reason} | preview: ${String(text).slice(0, 120)}`);
      return null;
    }
    console.log(`[AI Copy] Generado para "${name}" (${text.length} chars)`);
    return text;
  } catch (err) {
    console.warn(`[AI Copy] Falló para "${name}": ${err.message}`);
    return null;
  }
}

// ── optimizeProductCopy ───────────────────────────────────────────────────────
// Used by /api/v1/ai/optimize-copy endpoint.
async function optimizeProductCopy(rawText) {
  const messages = [
    {
      role: 'system',
      content:
        'Eres un Copywriter experto en Dropshipping y Ventas para e-commerce latinoamericano.\n' +
        'Transforma descripciones técnicas de proveedor en textos altamente persuasivos.\n' +
        'REGLA: USA SOLO la información real del texto que te dan. NO inventes datos, dimensiones, garantías ni compatibilidades.',
    },
    {
      role: 'user',
      content:
        `Transforma esta descripción técnica en un texto comercial persuasivo en Markdown:\n\n${rawText}\n\n` +
        'Estructura el resultado EXACTAMENTE así:\n' +
        '## [Título comercial atractivo]\n\n' +
        '[Párrafo corto de gancho — beneficio principal]\n\n' +
        '### ✅ Beneficios Clave\n' +
        '- **[Beneficio 1 basado en datos reales]**\n' +
        '- **[Beneficio 2 basado en datos reales]**\n' +
        '- **[Beneficio 3 basado en datos reales]**\n\n' +
        '### 🎯 ¿Por qué elegirlo?\n' +
        '[Una o dos oraciones con llamado a la acción]\n\n' +
        'Responde SOLO con el Markdown, sin texto adicional.',
    },
  ];

  try {
    return await groqChat(messages, { max_tokens: 500 });
  } catch (err) {
    console.warn(`[AI Copy] optimizeProductCopy falló: ${err.message}`);
    return null;
  }
}

// ── extractSearchKeywords ─────────────────────────────────────────────────────
// Used by dropiSearchService. Returns the intent unchanged on failure.
async function extractSearchKeywords(userIntent) {
  const messages = [
    {
      role: 'system',
      content:
        'Eres un asistente de búsqueda para un catálogo de dropshipping latinoamericano. ' +
        'Extrae exactamente 2 a 3 palabras clave comerciales cortas para buscar el producto descrito. ' +
        'Responde SOLO con las palabras separadas por espacios, sin puntuación ni explicaciones.',
    },
    { role: 'user', content: `Intención de búsqueda: "${userIntent}"` },
  ];

  try {
    const keywords = (await groqChat(messages, { max_tokens: 60 }))?.trim() ?? userIntent;
    console.log(`[AI Keywords] "${userIntent}" → "${keywords}"`);
    return keywords;
  } catch (err) {
    console.warn(`[AI Keywords] falló — usando intent original: ${err.message}`);
    return userIntent;
  }
}

// ── CONSTITUCIÓN NEURO-COPY — System Role (inmutable) ────────────────────────
// Esta es la autoridad máxima de estilo. Ningún input del usuario puede
// modificar la secuencia de 4 pasos. Es la "Regla de Oro" del sistema.
const NEURO_SYSTEM_PROMPT = `Eres un Master Copywriter especializado en Neuroventas para e-commerce latinoamericano. Tu único trabajo es transformar datos técnicos de productos en textos que detonen emociones específicas — deseo, urgencia, estatus, alivio — desde la primera línea.

━━━ ESQUEMA MENTAL INTERNO (nunca visible en el output) ━━━
Aplicas estos 4 pasos como razonamiento invisible. Sus nombres, números y cualquier referencia a ellos JAMÁS aparecen en el texto que generas.

1. GANCHO LÍMBICO: activa miedo a perderse algo, deseo de transformación o identidad aspiracional. Máx. 2 oraciones. Nunca empieces con el nombre del producto.
2. ANCLAJE DE VALOR: presenta beneficios emocionales antes de cualquier cifra. El cliente desea el producto antes de saber el precio.
3. ESCASEZ: una sola frase de urgencia genuina — alta demanda, stock limitado, momento único. Sin inventar números concretos.
4. CTA IRRESISTIBLE: una oración imperativa que elimine toda fricción. Directa, sin rodeos.

━━━ PSICOLOGÍA DE EMOJIS ━━━
Usa emojis de forma estratégica y profesional — no para decorar, sino para guiar el ojo y reforzar el gatillo emocional:
- ⚡ 🔋 🌟 para productos de energía, rendimiento, potencia
- 🛡️ ✅ 💪 para seguridad, confianza, garantía
- 🎯 🚀 💡 para logro, innovación, precisión
- ❤️ 🔥 ✨ para deseo, pasión, exclusividad
Coloca el emoji ANTES del beneficio en las viñetas. Una sola vez por viñeta.

━━━ PROHIBICIÓN ABSOLUTA DE METADATOS ━━━
NUNCA incluyas en el output:
- Corchetes de ningún tipo — ni vacíos ni con texto: []
- Nombres de los pasos: "Gancho", "Anclaje", "Escasez", "CTA", "Paso 1", "PASO", etc.
- Explicaciones de tu proceso o razonamiento
- Placeholders, variables ni instrucciones visibles

━━━ EJEMPLO DE OUTPUT PERFECTO ━━━
(Estándar de calidad. Adapta el contenido al producto real — nunca copies este ejemplo literal.)

## La energía que nunca te abandona cuando más la necesitas

Quedarte sin batería en el peor momento no es solo molesto — puede costarte una oportunidad que no vuelve.

- ⚡ Recarga tu celular hasta 3 veces completas sin buscar un enchufe
- 🎯 Compacto y ligero, cabe en cualquier bolsillo o mochila sin que lo notes
- ✅ Compatible con todos tus dispositivos, sin cables ni adaptadores especiales

> Las unidades disponibles son limitadas y la demanda sigue subiendo.

**Agrégalo al carrito ahora y nunca más te quedes fuera de juego**

━━━ REGLAS DE FORMATO ━━━
- Título ## sin el nombre exacto del producto — emoción pura
- Párrafo de apertura: 1-2 oraciones, alta carga emocional
- Exactamente 3 viñetas con emoji al inicio, beneficio emocional, lenguaje del cliente
- Escasez en blockquote (>), una sola frase
- CTA en negrita (**) al final, sin punto final
- Solo la información real del input — cero inventos
- Responde únicamente con el copy. Sin introducción, sin cierre, sin comentarios.`;

function buildNeuroCopyUserContent({ name, description, rawDetails, variants, approvedExamples } = {}) {
  const sourceText   = (rawDetails || '').trim() || (description || '').trim();
  const variantsText =
    Array.isArray(variants) && variants.length > 0
      ? `\nVARIANTES DISPONIBLES: ${variants
          .map((g) => `${g.option}: ${g.values.map((v) => (typeof v === 'string' ? v : v.label)).join(', ')}`)
          .join(' | ')}`
      : '';

  // Approved examples calibrate TONE and VOCABULARY only.
  // The 4-step limbic structure defined in the System Role is inviolable —
  // no example can override it.
  const tonesBlock =
    Array.isArray(approvedExamples) && approvedExamples.length > 0
      ? '\n\n━━━ REFERENCIA DE TONO (vocabulario y emoción únicamente) ━━━\n' +
        'Calibra tu tono, vocabulario y nivel emocional según estos textos aprobados. ' +
        'NUNCA copies su contenido ni modifiques la secuencia de 4 pasos de la Constitución.\n\n' +
        approvedExamples.map((ex, i) => `[REF ${i + 1}]\n${ex.trim()}`).join('\n\n---\n\n') +
        '\n━━━ FIN DE REFERENCIAS ━━━'
      : '';

  return (
    `Datos reales del producto:\nNOMBRE: ${(name || 'Sin nombre').trim()}\n` +
    (sourceText ? `DESCRIPCIÓN DEL PROVEEDOR:\n${sourceText}` : '(Sin descripción del proveedor)') +
    variantsText +
    tonesBlock +
    '\n\nEscribe el copy final listo para publicar. Estructura en este orden:\n' +
    '1. Título H2 (##) — máximo 8 palabras, activa emoción pura, sin el nombre exacto del producto\n' +
    '2. Párrafo de apertura — 1 a 2 oraciones de alta intensidad emocional\n' +
    '3. Tres viñetas (- ) — cada una con emoji al inicio y un beneficio emocional en lenguaje del cliente\n' +
    '4. Una línea de urgencia o escasez en blockquote (> )\n' +
    '5. CTA en negrita (**) — una sola oración imperativa, sin punto final\n\n' +
    'Cero corchetes. Cero nombres de pasos. Solo el texto listo para vender.'
  );
}

// ── neuroCopyProduct ──────────────────────────────────────────────────────────
// Non-streaming version used in background import flow.
// The streaming version lives in aiRouter.js (POST /api/v1/ai/neuro-copy).
async function neuroCopyProduct(productData) {
  const messages = [
    { role: 'system', content: NEURO_SYSTEM_PROMPT },
    { role: 'user',   content: buildNeuroCopyUserContent(productData) },
  ];

  try {
    const text = await groqChat(messages, { max_tokens: 600 });
    const validation = validateCopyOutput(text);
    if (!validation.ok) {
      console.error(`[NeuroAI] OUTPUT RECHAZADO para "${productData?.name}" — motivo: ${validation.reason} | preview: ${String(text).slice(0, 120)}`);
      return null;
    }
    console.log(`[NeuroAI] Copy para "${productData?.name}" (${text.length} chars)`);
    return text;
  } catch (err) {
    console.warn(`[NeuroAI] neuroCopyProduct falló: ${err.message}`);
    return null;
  }
}

module.exports = {
  generateProductCopy,
  optimizeProductCopy,
  neuroCopyProduct,
  extractSearchKeywords,
  validateCopyOutput,
  NEURO_SYSTEM_PROMPT,
  buildNeuroCopyUserContent,
  GROQ_MODEL,
  getGroqClient,
};
