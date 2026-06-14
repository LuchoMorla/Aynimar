'use strict';

const { fetchDropiCatalog } = require('./dropiAdapter');
const { extractSearchKeywords } = require('../aiCopyService');

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
  page          = 1,
  limit         = 24,
  categoryId    = null,
  priceMin      = null,
  priceMax      = null,
  userVerified  = false,
} = {}) {
  const kw = (keyword ?? '').trim();
  if (!kw) return { products: [], total: 0, page };
  return fetchDropiCatalog({ page, limit, keyword: kw, categoryId, priceMin, priceMax, userVerified });
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

// Image search disabled — multipart/Buffer approach caused OOM on Railway.
// Returns empty payload with disabled flag so the route can signal the client cleanly.
// eslint-disable-next-line no-unused-vars
async function searchByImage(imageBase64, opts = {}) {
  return { products: [], total: 0, page: 1, disabled: true };
}

module.exports = { searchByText, searchByAI, searchByImage };
