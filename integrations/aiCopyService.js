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
    console.log(`[AI Copy] Generado para "${name}" (${text?.length ?? 0} chars)`);
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

// ── Shared neuro-marketing system prompt ─────────────────────────────────────
// Used by both the streaming endpoint (aiRouter) and background import flow.
const NEURO_SYSTEM_PROMPT =
  'Actúa como un experto en neuro-marketing y copywriting de alta conversión para e-commerce latinoamericano.\n' +
  'Escribe una descripción de producto aplicando estas técnicas psicológicas de forma natural y persuasiva:\n\n' +
  '1. Sesgo de Anclaje: Presenta el valor percibido y el beneficio ANTES de cualquier referencia al precio.\n' +
  '2. Principio de Escasez/Urgencia: Incluye UNA frase sutil que incite a la acción inmediata (sin inventar stock).\n' +
  '3. Reducción de Carga Cognitiva: Usa frases cortas, viñetas y lenguaje simple y directo.\n' +
  '4. Activación del Sistema Límbico: Enfócate en el beneficio EMOCIONAL — qué siente el cliente al tenerlo.\n\n' +
  'REGLA ABSOLUTA: USA SOLO la información real que te proporcionan. NO inventes especificaciones ni precios.\n' +
  'Responde ÚNICAMENTE con el texto en Markdown, sin prefacio ni explicaciones adicionales.';

function buildNeuroCopyUserContent({ name, description, rawDetails, variants } = {}) {
  const sourceText   = (rawDetails || '').trim() || (description || '').trim();
  const variantsText =
    Array.isArray(variants) && variants.length > 0
      ? `\nVARIANTES DISPONIBLES: ${variants
          .map((g) => `${g.option}: ${g.values.map((v) => (typeof v === 'string' ? v : v.label)).join(', ')}`)
          .join(' | ')}`
      : '';

  return (
    `Datos reales del producto:\nNOMBRE: ${(name || 'Sin nombre').trim()}\n` +
    (sourceText ? `DESCRIPCIÓN ORIGINAL DEL PROVEEDOR:\n${sourceText}` : '(Sin descripción adicional del proveedor)') +
    variantsText +
    '\n\nEscribe la descripción neuro-optimizada con EXACTAMENTE este formato en español:\n\n' +
    '## [Título impactante — máx. 10 palabras, orientado al beneficio emocional]\n\n' +
    '[Párrafo de gancho: 1-2 oraciones que conectan con lo que el cliente SIENTE al tenerlo]\n\n' +
    '### ¿Por qué lo van a querer?\n' +
    '- **[Beneficio emocional 1]:** [explicación breve]\n' +
    '- **[Beneficio emocional 2]:** [explicación breve]\n' +
    '- **[Beneficio emocional 3]:** [explicación breve]\n\n' +
    '### [Llamado a la acción con urgencia sutil — 1 oración concisa]'
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
    console.log(`[NeuroAI] Copy para "${productData?.name}" (${text?.length ?? 0} chars)`);
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
  NEURO_SYSTEM_PROMPT,
  buildNeuroCopyUserContent,
  GROQ_MODEL,
  getGroqClient,
};
