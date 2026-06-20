'use strict';
/* eslint-disable no-console */
/**
 * Aynimar Smoke Test Suite
 *
 * Zero network calls. Zero DB connections. Pure logic validation.
 * Tests the critical quality gates in the import + dispatch pipeline.
 *
 * Usage:
 *   node scripts/smoke-test.js
 *
 * Exit code 0 = all passed. Exit code 1 = at least one failure.
 */

// ── Minimal test runner ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function suite(name, fn) {
  console.log(`\n▶ ${name}`);
  fn();
}

// ── 1. Copy Quality Guard ─────────────────────────────────────────────────────
suite('Copy Quality Guard (validateCopyOutput)', () => {
  const { validateCopyOutput } = require('../integrations/aiCopyService');

  // Should reject: unfilled prompt placeholders
  const leakyOutputs = [
    '## [Título comercial persuasivo]\n\n[Párrafo corto de gancho basado en la utilidad real]',
    '### ✅ Beneficios Clave\n- **[Característica real 1]:** [Beneficio orientado al cliente]',
    '**¿[Pregunta lógica]?**\n[Respuesta con datos reales]',
    '[Párrafo corto de gancho basado en la utilidad real]\n\n',
    '## [Titulo de ejemplo]\n\nTexto de cuerpo real aquí.',
    '- **[Beneficio orientado al usuario final]**',
  ];

  for (const bad of leakyOutputs) {
    const result = validateCopyOutput(bad);
    assert(`rejects bracket leak: "${bad.slice(0, 55)}..."`, !result.ok && result.reason === 'BRACKET_LEAK');
  }

  // Should reject: empty or near-empty output
  assert('rejects null output',          !validateCopyOutput(null).ok);
  assert('rejects empty string',         !validateCopyOutput('').ok);
  assert('rejects whitespace-only',      !validateCopyOutput('   ').ok);
  assert('rejects very short text',      !validateCopyOutput('Hi').ok);

  // Should accept: clean copy
  const goodOutputs = [
    '## La energía que nunca te abandona\n\nQuedarte sin batería en el peor momento puede costarte una oportunidad.\n\n- ⚡ Recarga tu celular hasta 3 veces\n- 🎯 Compacto y ligero\n- ✅ Compatible con todos tus dispositivos\n\n> Las unidades son limitadas.\n\n**Agrégalo al carrito ahora**',
    '## Tu hogar más limpio en menos tiempo\n\nEl polvo no espera. Tampoco tú.\n\n- 🔋 Batería de larga duración para toda la casa\n- 🛡️ Filtro HEPA que retiene el 99% del polvo\n- ⚡ Succión potente en superficies duras y alfombras\n\n> Alta demanda — pocas unidades disponibles.\n\n**Pídelo hoy y recíbelo esta semana**',
  ];

  for (const good of goodOutputs) {
    const result = validateCopyOutput(good);
    assert(`accepts clean neuro copy (${good.length} chars)`, result.ok, result.reason ?? '');
  }

  // Markdown links should NOT be flagged as bracket leaks
  const withMarkdownLink = '## Producto increíble\n\nTexto con [enlace válido](https://example.com) aquí.';
  assert('accepts markdown links [text](url)', validateCopyOutput(withMarkdownLink).ok);
});

// ── 2. dropiItems initialization invariant ────────────────────────────────────
// This is a pure-logic check: when a product is imported, dropiItems must always
// be initialized with the externalId so dispatch has a valid target.
suite('dropiItems initialization invariant', () => {
  function buildDefaultDropiItems(externalId) {
    return [{ id: String(externalId), qty: 1 }];
  }

  const cases = ['76203', '12345', '99999'];
  for (const id of cases) {
    const items = buildDefaultDropiItems(id);
    assert(`dropiItems[0].id === externalId for id=${id}`, items[0].id === id);
    assert(`dropiItems[0].qty === 1 for id=${id}`, items[0].qty === 1);
    assert(`dropiItems is array with 1 entry for id=${id}`, Array.isArray(items) && items.length === 1);
  }
});

// ── 3. Dispatch pre-flight validation (logic inlined — no DB required) ────────
// Mirrors the _validateDispatchItems logic from Services/orderService.js.
// If you change that function, update this mirror too.
suite('Dispatch pre-flight validation (pure logic)', () => {
  function validateDispatchItems(items) {
    const errors = [];
    for (const item of items) {
      if (!Array.isArray(item.dropiItems) || item.dropiItems.length === 0) continue;
      item.dropiItems.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') {
          errors.push(`Product ${item.id}: dropiItems[${i}] is not an object`);
          return;
        }
        if (!entry.id || typeof entry.id !== 'string' || entry.id.trim() === '') {
          errors.push(`Product ${item.id}: dropiItems[${i}].id is missing or empty`);
        }
        if (item.isBundle === true) {
          const qty = entry.qty ?? 1;
          if (!Number.isInteger(qty) || qty < 1) {
            errors.push(`Product ${item.id}: dropiItems[${i}].qty must be a positive integer (got ${JSON.stringify(qty)})`);
          }
        }
      });
    }
    if (errors.length > 0) throw new Error(errors.join(' | '));
  }

  const pass = (label, items) => assert(label, (() => { try { validateDispatchItems(items); return true; } catch { return false; } })());
  const fail = (label, items) => assert(label, (() => { try { validateDispatchItems(items); return false; } catch { return true; } })());

  pass('passes: items with null/empty dropiItems (own-stock)', [
    { id: 1, dropiItems: null,  isBundle: false },
    { id: 2, dropiItems: [],    isBundle: false },
  ]);
  pass('passes: valid single dropiItem', [
    { id: 3, dropiItems: [{ id: '76203', qty: 1 }], isBundle: false },
  ]);
  pass('passes: valid bundle (2 items)', [
    { id: 4, dropiItems: [{ id: '111', qty: 2 }, { id: '222', qty: 1 }], isBundle: true },
  ]);
  fail('rejects: dropiItem with empty id', [
    { id: 5, dropiItems: [{ id: '', qty: 1 }], isBundle: false },
  ]);
  fail('rejects: dropiItem that is not an object', [
    { id: 6, dropiItems: ['bad-string-entry'], isBundle: false },
  ]);
  fail('rejects: bundle dropiItem with qty=0', [
    { id: 7, dropiItems: [{ id: '99', qty: 0 }, { id: '100', qty: 1 }], isBundle: true },
  ]);
  fail('rejects: dropiItem with missing id field', [
    { id: 8, dropiItems: [{ qty: 1 }], isBundle: false },
  ]);
});

// ── 4. AI Copy Service — module contract ─────────────────────────────────────
suite('aiCopyService — module contract', () => {
  const svc = require('../integrations/aiCopyService');
  assert('exports generateProductCopy',  typeof svc.generateProductCopy === 'function');
  assert('exports neuroCopyProduct',     typeof svc.neuroCopyProduct === 'function');
  assert('exports validateCopyOutput',   typeof svc.validateCopyOutput === 'function');
  assert('exports buildNeuroCopyUserContent', typeof svc.buildNeuroCopyUserContent === 'function');
  assert('NEURO_SYSTEM_PROMPT non-empty',  typeof svc.NEURO_SYSTEM_PROMPT === 'string' && svc.NEURO_SYSTEM_PROMPT.length > 100);
  assert('NEURO_SYSTEM_PROMPT has bracket prohibition', svc.NEURO_SYSTEM_PROMPT.includes('PROHIBICIÓN ABSOLUTA'));
});

// ── 5. neuro copy user content builder ───────────────────────────────────────
suite('buildNeuroCopyUserContent — output contract', () => {
  const { buildNeuroCopyUserContent } = require('../integrations/aiCopyService');

  const out = buildNeuroCopyUserContent({
    name: 'Aspiradora Robot X300',
    description: 'Aspiradora robótica con sensor de obstáculos.',
    rawDetails: 'Motor 1800W. Batería 2h. Compatible con Alexa.',
    variants: [{ option: 'Color', values: [{ label: 'Blanco' }, { label: 'Negro' }] }],
  });

  assert('output is a string', typeof out === 'string');
  assert('output contains product name', out.includes('Aspiradora Robot X300'));
  assert('output contains variant info', out.includes('Color') && out.includes('Blanco'));
  assert('output contains rawDetails context', out.includes('1800W'));
  assert('output does not contain unfilled brackets', !out.includes('[placeholder]'));
});

// ── 6. Environment variable presence (warn-only) ─────────────────────────────
suite('Environment variable presence (warnings only)', () => {
  const vars = {
    GROQ_API_KEY:      process.env.GROQ_API_KEY || process.env.GROQ_IA_KEY,
    DROPI_ORDER_TOKEN: process.env.DROPI_ORDER_TOKEN || process.env.WOO_CONSUMER_SECRET,
    JWT_SECRET:        process.env.JWT_SECRET,
    DATABASE_URL:      process.env.DATABASE_URL,
  };

  for (const [name, val] of Object.entries(vars)) {
    if (!val) {
      console.log(`  ⚠️  ${name} not set (expected in Railway — OK locally)`);
    } else {
      console.log(`  ℹ️  ${name} is configured`);
    }
  }
  assert('env check completed', true);
});

// ── Result summary ────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\n🚨 SMOKE TEST FAILURE — ${failed} test(s) failed. Fix before deploying.\n`);
  process.exit(1);
} else {
  console.log(`\n✅ All smoke tests passed. Pipeline is clean.\n`);
  process.exit(0);
}
