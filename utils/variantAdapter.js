'use strict';

/**
 * @typedef {{ label: string, image?: string, stock?: number }} VariantValue
 * @typedef {{ option: string, values: VariantValue[] }} VariantGroup
 * @typedef {{ id: string, value?: string, name?: string, qty?: number }} DropiItem
 * @typedef {{ id: string, label: string }} NormalizedVariant
 * @typedef {{ productId: number, productName: string, isBundle: boolean, variants: NormalizedVariant[], dispatchDescription: string }} ProductPayload
 */

/**
 * Parse the variants TEXT field (JSON.stringify) safely.
 * @param {string|null|undefined} variantsText
 * @returns {VariantGroup[]}
 */
function parseVariantGroups(variantsText) {
  if (!variantsText) return [];
  try {
    const parsed = JSON.parse(variantsText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Given a selectedDropiId and dropiItems, find the human-readable variant label.
 * Priority: entry.value > entry.name > raw id
 * @param {string} selectedDropiId
 * @param {DropiItem[]} dropiItems
 * @returns {string}
 */
function resolveVariantLabel(selectedDropiId, dropiItems) {
  const entry = dropiItems.find((d) => String(d.id) === String(selectedDropiId));
  if (!entry) return selectedDropiId;
  return (entry.value || entry.name || selectedDropiId).trim();
}

/**
 * Build the human-readable dispatch description for a single order item.
 *
 * Format:
 *   Variant product → "Nombre Producto - [Azul / XL]"
 *   Bundle product  → "Nombre Producto - Kit [Comp A] [Comp B]"
 *   Simple product  → "Nombre Producto"
 *
 * @param {{ name: string, isBundle?: boolean|null, dropiItems?: DropiItem[]|null }} product
 * @param {string|null} selectedDropiId  from OrderProduct.selectedDropiId
 * @returns {string}
 */
function buildDispatchDescription(product, selectedDropiId) {
  const name       = (product.name || 'Producto').trim();
  const dropiItems = Array.isArray(product.dropiItems) ? product.dropiItems : [];

  if (product.isBundle === true && dropiItems.length > 0) {
    const parts = dropiItems
      .map((d) => (d.name || d.value || String(d.id)).trim())
      .filter(Boolean);
    return `${name} - Kit ${parts.map((p) => `[${p}]`).join(' ')}`.trim();
  }

  if (dropiItems.length > 0) {
    const resolvedId = selectedDropiId || dropiItems[0]?.id;
    if (resolvedId) {
      const label = resolveVariantLabel(String(resolvedId), dropiItems);
      return `${name} - [${label}]`;
    }
  }

  return name;
}

/**
 * Normalize any Dropi variant input into a flat list of {id, label} pairs.
 *
 * Accepts two formats:
 *   dropiItems format: [{id, value?, name?}]         → from Product.dropiItems (JSONB)
 *   variantGroup format: [{option, values:[{label}]}] → from Product.variants (TEXT)
 *
 * @param {string|DropiItem[]|VariantGroup[]|null|undefined} rawInput
 * @returns {NormalizedVariant[]}
 */
function normalizeDropiVariants(rawInput) {
  let parsed = rawInput;
  if (typeof rawInput === 'string') {
    try { parsed = JSON.parse(rawInput); } catch { return []; }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];

  const first = parsed[0];

  // dropiItems format: items have an `id` but no `option`
  if (typeof first.id !== 'undefined' && typeof first.option === 'undefined') {
    return parsed.map((d) => ({
      id:    String(d.id),
      label: (d.value || d.name || String(d.id)).trim(),
    }));
  }

  // variantGroup format: items have an `option` and `values` array
  if (typeof first.option !== 'undefined' && Array.isArray(first.values)) {
    return parsed.flatMap((group) =>
      group.values.map((v) => ({
        id:    typeof v === 'string' ? v : v.label,
        label: typeof v === 'string' ? v : v.label,
      }))
    );
  }

  return [];
}

module.exports = { parseVariantGroups, resolveVariantLabel, buildDispatchDescription, normalizeDropiVariants };
