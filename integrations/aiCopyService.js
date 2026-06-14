'use strict';

const axios = require('axios');

/**
 * Generates a structured Markdown product description using Claude Haiku.
 *
 * STRICT RULE: The AI must use ONLY the real data provided (name + rawDescription).
 * It must NOT invent specifications, dimensions, compatibility, or guarantees.
 * Its role is to REWRITE existing Dropi data using AIDA/PAS copywriting techniques.
 *
 * Returns null if ANTHROPIC_API_KEY is not set or the call fails — import continues.
 */
async function generateProductCopy(name, rawDescription) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const hasRealData = rawDescription && rawDescription.trim().length > 10;

  const systemPrompt = `Eres un experto en copywriting de alta conversión para e-commerce latinoamericano.
Tu única fuente de verdad son los datos reales que te proporciona el proveedor Dropi.
REGLA ABSOLUTA: NO inventes especificaciones, dimensiones, materiales, garantías ni compatibilidades que no estén explícitamente en los datos del proveedor.
Tu trabajo es TRANSFORMAR esa data técnica usando las técnicas AIDA y PAS, haciéndola persuasiva y orientada al beneficio del comprador.
Si un dato no está en la fuente, NO lo incluyas. Es mejor ser breve y preciso que inventar.`;

  const userContent = `Datos reales del producto de Dropi (fuente de verdad absoluta):
NOMBRE: ${name}
${hasRealData ? `DESCRIPCIÓN ORIGINAL DEL PROVEEDOR:\n${rawDescription}` : '(Sin descripción adicional del proveedor)'}

Reescribe estos datos en Markdown estructurado con EXACTAMENTE estos 4 bloques, usando SOLO la información real provista:

## [Título comercial persuasivo — basado en el nombre real del producto]

[Párrafo corto de gancho: identifica el dolor o necesidad que resuelve este producto, basado en su utilidad real]

### ✅ Beneficios Clave
- **[Característica real 1]:** [Beneficio orientado al cliente]
- **[Característica real 2]:** [Beneficio orientado al cliente]
- **[Característica real 3]:** [Beneficio orientado al cliente]

### ❓ Preguntas Frecuentes

**¿[Pregunta lógica basada en la data real]?**
[Respuesta usando solo información real del proveedor]

**¿[Pregunta sobre uso o compatibilidad — solo si hay datos para responderla]?**
[Respuesta honesta y precisa]

IMPORTANTE: Si no tienes datos suficientes para un beneficio o FAQ, omítelo. Nunca inventes.
Responde SOLO con el Markdown, sin texto adicional.`;

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userContent }],
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 20000,
      }
    );
    const text = data?.content?.[0]?.text ?? null;
    console.log(`[AI Copy] Generado para "${name}" (${text?.length ?? 0} chars)`);
    return text;
  } catch (err) {
    console.warn(`[AI Copy] Falló para "${name}": ${err.message}`);
    return null;
  }
}

/**
 * Rewrites an existing product description into persuasive e-commerce copy.
 * Used by the manual importer's "Optimizar con IA" button.
 * Returns the optimized Markdown string, or null if the call fails.
 */
async function optimizeProductCopy(rawText) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const systemPrompt = `Eres un Copywriter experto en Dropshipping y Ventas para e-commerce latinoamericano.
Tu trabajo es transformar descripciones técnicas de proveedor en textos altamente persuasivos.
REGLA: USA SOLO la información real del texto que te dan. NO inventes datos, dimensiones, garantías ni compatibilidades.`;

  const userContent = `Transforma esta descripción técnica de proveedor en un texto comercial persuasivo en Markdown:

${rawText}

Estructura el resultado EXACTAMENTE así:
## [Título comercial atractivo]

[Párrafo corto de gancho — beneficio principal para el comprador]

### ✅ Beneficios Clave
- **[Beneficio 1 basado en datos reales]**
- **[Beneficio 2 basado en datos reales]**
- **[Beneficio 3 basado en datos reales]**

### 🎯 ¿Por qué elegirlo?
[Una o dos oraciones con llamado a la acción contundente]

Responde SOLO con el Markdown, sin texto adicional.`;

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userContent }],
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        timeout: 20000,
      }
    );
    return data?.content?.[0]?.text ?? null;
  } catch (err) {
    console.warn(`[AI Copy] optimizeProductCopy falló: ${err.message}`);
    return null;
  }
}

module.exports = { generateProductCopy, optimizeProductCopy };
