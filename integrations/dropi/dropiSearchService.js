'use strict';

const { fetchDropiCatalog, searchDropiByImage } = require('./dropiAdapter');
const { extractSearchKeywords }                 = require('../aiCopyService');

/**
 * SEARCH TYPE 1 — Clásica (texto / keywords)
 *
 * Llama directamente al catálogo en vivo de Dropi
 * (POST /api/products/v4/index, modo semántico).
 * El cliente HTTP ya tiene el token y el 2FA resueltos en dropiAdapter.
 *
 * @returns {{ products, total, page }}
 */
async function searchByText(keyword, {
  page       = 1,
  limit      = 24,
  categoryId = null,
  priceMin   = null,
  priceMax   = null,
} = {}) {
  const kw = (keyword ?? '').trim();
  if (!kw) return { products: [], total: 0, page };
  return fetchDropiCatalog({ page, limit, keyword: kw, categoryId, priceMin, priceMax });
}

/**
 * SEARCH TYPE 2 — Asistente IA
 *
 * 1. Extrae 2–3 keywords comerciales de la intención del usuario
 *    usando Claude Haiku (llamada ligera de 60 tokens).
 * 2. Inyecta esas keywords directamente en searchByText sobre el catálogo
 *    en vivo de Dropi. No abre ningún pipeline adicional.
 *
 * Si ANTHROPIC_API_KEY no está configurado o la llamada falla,
 * cae en silencio a una búsqueda de texto con el intent original.
 *
 * @returns {{ products, total, page, extractedKeywords }}
 */
async function searchByAI(userIntent, options = {}) {
  const keywords = await extractSearchKeywords(userIntent);
  console.log(`[Dropi AI Search] intent="${userIntent}" → keywords="${keywords}"`);
  const result = await searchByText(keywords, options);
  return { ...result, extractedKeywords: keywords };
}

/**
 * SEARCH TYPE 3 — Búsqueda inversa por imagen (nativa Dropi)
 *
 * Envía el base64 de la imagen directamente al motor de búsqueda
 * visual de Dropi (POST /api/products/v4/index con search_type:"image").
 * Usa el mismo cliente HTTP con token + 2FA que ya maneja dropiAdapter.
 * Sin procesamiento de IA, sin servicios externos.
 *
 * @param {string} imageBase64  — imagen en base64, con o sin prefijo data-URL
 * @returns {{ products, total, page }}
 */
async function searchByImage(imageBase64, { page = 1, limit = 24 } = {}) {
  // Strip data-URL prefix if the frontend sends "data:image/jpeg;base64,..."
  const clean = imageBase64.replace(/^data:image\/[a-z+]+;base64,/i, '');
  return searchDropiByImage({ imageBase64: clean, page, limit });
}

module.exports = { searchByText, searchByAI, searchByImage };
