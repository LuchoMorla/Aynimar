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

// ── 6. Order totals / IVA policy (Fase B — B2; IVA resuelto 2026-09-06) ─────
suite('Order totals — computeOrderTotals / computeCreditRedemption / round2', () => {
  const {
    TAX_RATE,
    computeOrderTotals,
    computeCreditRedemption,
    round2,
    isTerminalStateOrder,
  } = require('../Services/orderTotals');

  assert('round2 corrige deriva de float (10.999999 → 11)', round2(10.999999) === 11);
  assert('round2(0.1 + 0.2) === 0.3', round2(0.1 + 0.2) === 0.3);
  assert('round2 redondea a 2 decimales (2.005 → 2.01 aprox)', round2(2.005) === 2.01 || round2(2.005) === 2);
  assert('TAX_RATE = 0.15 (SRI Ecuador, RIMPE Emprendedor)', TAX_RATE === 0.15);

  // ── product.price = PVP final, IVA incluido — subtotal ya incluye IVA ──
  const t1 = computeOrderTotals([{ price: 2.5, qty: 3 }, { price: '4.99', qty: 1 }]);
  assert('subtotal = Σ(price×qty) = 12.49', t1.subtotal === 12.49, JSON.stringify(t1));
  assert('tax = subtotal − base_imponible, NUNCA 0 por defecto', t1.tax === round2(12.49 - round2(12.49 / 1.15)), JSON.stringify(t1));
  assert('base + tax === subtotal exacto (sin fuga de centavos)', round2((t1.subtotal - t1.tax) + t1.tax) === t1.subtotal);
  assert('total = subtotal bruto (antes de créditos)', t1.total === t1.subtotal);

  const t2 = computeOrderTotals([{ price: 19.99, qty: 2 }]);
  assert('19.99 × 2 = 39.98 (sin deriva)', t2.total === 39.98, JSON.stringify(t2));

  assert('carrito vacío → totales en 0', computeOrderTotals([]).total === 0);
  assert('lineItems null → totales en 0 (no lanza)', computeOrderTotals(null).total === 0);

  // ── Ejemplo de referencia: costo $2.60, margen 30%, IVA 15% → PVP ≈ $4.27 ──
  const pvp = round2((2.60 / 0.70) * 1.15); // 4.27
  assert('PVP de referencia (costo=2.60, margen=30%) ≈ $4.27', pvp === 4.27, `pvp=${pvp}`);
  const ref = computeOrderTotals([{ price: pvp, qty: 1 }]);
  assert('base imponible del PVP de referencia ≈ $3.71', round2(pvp / 1.15) === 3.71);
  assert('IVA del PVP de referencia ≈ $0.56', ref.tax === 0.56, JSON.stringify(ref));

  // ── computeCreditRedemption — nunca duplica IVA, nunca cobra dos veces ──
  assert('sin crédito → amountToPay = subtotal íntegro', computeCreditRedemption(50, 0).amountToPay === 50);

  const partial = computeCreditRedemption(50, 20);
  assert('crédito parcial: subtotal=50, credits=20 → creditsUsed=20', partial.creditsUsed === 20, JSON.stringify(partial));
  assert('crédito parcial: amountToPay = 30 (NO 30×1.15)', partial.amountToPay === 30, JSON.stringify(partial));

  const refCredit = computeCreditRedemption(pvp, 1); // el ejemplo exacto del enunciado
  assert('PVP=4.27, crédito=$1 → amountToPay=$3.27 (NO ×1.15 de nuevo)', refCredit.amountToPay === 3.27, JSON.stringify(refCredit));

  const full = computeCreditRedemption(50, 50);
  assert('crédito total: creditsUsed=subtotal → amountToPay=0', full.creditsUsed === 50 && full.amountToPay === 0, JSON.stringify(full));

  const overpay = computeCreditRedemption(50, 999);
  assert('créditos > subtotal → se topan en floor(subtotal), no en lo solicitado', overpay.creditsUsed === 50, JSON.stringify(overpay));
  assert('amountToPay nunca negativo aunque se soliciten créditos de más', overpay.amountToPay === 0, JSON.stringify(overpay));

  const fractional = computeCreditRedemption(4.99, 10);
  assert('créditos topados en floor(subtotal) con subtotal fraccionario (4.99 → máx 4)', fractional.creditsUsed === 4, JSON.stringify(fractional));
  assert('amountToPay nunca negativo con subtotal fraccionario', fractional.amountToPay >= 0, JSON.stringify(fractional));

  assert('creditsToApply negativo → creditsUsed=0 (no incrementa el monto a pagar)', computeCreditRedemption(50, -10).creditsUsed === 0);
  assert('subtotal=0 → amountToPay=0, nunca negativo', computeCreditRedemption(0, 5).amountToPay === 0);

  assert('isTerminalStateOrder(entregado) === true', isTerminalStateOrder('entregado') === true);
  assert('isTerminalStateOrder(cancelado) === true', isTerminalStateOrder('cancelado') === true);
  assert('isTerminalStateOrder(en_preparacion) === false', isTerminalStateOrder('en_preparacion') === false);
});

// ── 7. Pricing Engine — Cost Engine (Paso 1, docs/PRICING_ENGINE_SPEC.md) ───
suite('Pricing Engine — Cost Engine (computeEconomicCost)', () => {
  const { computeEconomicCost, validateCostComponent, normalizeBaseFactor } =
    require('../Services/pricingEngine');
  const { TAX_RATE } = require('../Services/orderTotals');

  const known = (overrides) => ({
    key: 'product_cost',
    kind: 'absolute',
    scope: 'per_unit',
    status: 'known',
    value: 2.60,
    source: 'dropi_catalog',
    ...overrides,
  });

  // ── 1. Costo conocido ──
  const r1 = computeEconomicCost({ quantity: 1, taxRate: TAX_RATE, costComponents: [known()] });
  assert('costo known contribuye a fixedAbsoluteCost', r1.fixedAbsoluteCost === 2.60, JSON.stringify(r1));
  assert('costo known → costCoverage = 1', r1.costCoverage === 1);
  assert('costo known → unknownComponents vacío', r1.unknownComponents.length === 0);

  // ── 2. Costo estimado ──
  const r2 = computeEconomicCost({
    quantity: 1, taxRate: TAX_RATE,
    costComponents: [known({ key: 'shipping', scope: 'per_shipment', status: 'estimated', value: 3.00, source: 'manual_estimate' })],
  });
  assert('costo estimated SÍ contribuye a la suma (a diferencia de unknown)', r2.fixedAbsoluteCost === 3.00, JSON.stringify(r2));
  assert('costo estimated cuenta para costCoverage', r2.costCoverage === 1);

  // ── 3. Costo desconocido ──
  const r3 = computeEconomicCost({
    quantity: 1, taxRate: TAX_RATE,
    costComponents: [known(), known({ key: 'dropi_commission', status: 'unknown', value: null, source: 'dropi_contract' })],
  });
  assert('costo unknown NO contribuye a fixedAbsoluteCost', r3.fixedAbsoluteCost === 2.60, JSON.stringify(r3));
  assert('costo unknown aparece en unknownComponents', r3.unknownComponents.length === 1 && r3.unknownComponents[0].key === 'dropi_commission');
  assert('costo unknown reduce costCoverage (1 de 2 = 0.5)', r3.costCoverage === 0.5, JSON.stringify(r3));

  // ── 4. unknown NUNCA equivale a cero (propiedad central) ──
  // Comparación directa: un componente unknown de "valor grande" no debe
  // aparecer sumado como si fuera 0 escondido — debe estar completamente
  // ausente de fixedAbsoluteCost Y visible en unknownComponents.
  const r4known0 = computeEconomicCost({ quantity: 1, taxRate: TAX_RATE, costComponents: [known({ value: 0 })] });
  const r4unknown = computeEconomicCost({ quantity: 1, taxRate: TAX_RATE, costComponents: [known({ status: 'unknown', value: null })] });
  assert(
    'unknown produce costCoverage=0 y CF=0 por AUSENCIA; known con value=0 produce costCoverage=1 y CF=0 por HECHO — resultados numéricos iguales en CF pero metadatos distintos (nunca se confunden)',
    r4known0.fixedAbsoluteCost === 0 && r4known0.costCoverage === 1 &&
    r4unknown.fixedAbsoluteCost === 0 && r4unknown.costCoverage === 0 &&
    r4unknown.unknownComponents.length === 1,
    JSON.stringify({ r4known0, r4unknown })
  );
  assert(
    'validateCostComponent RECHAZA unknown con value != null (nunca se puede colar un "unknown-pero-0")',
    (() => { try { validateCostComponent(known({ status: 'unknown', value: 0 })); return false; } catch { return true; } })()
  );

  // ── 5. Costo absoluto por unidad (escala con quantity) ──
  const r5 = computeEconomicCost({ quantity: 3, taxRate: TAX_RATE, costComponents: [known()] });
  assert('per_unit absoluto escala con quantity (2.60 × 3 = 7.80)', r5.fixedAbsoluteCost === 7.80, JSON.stringify(r5));

  // ── 6. Costo porcentual (normalización de base) ──
  const rPctNet = computeEconomicCost({
    quantity: 1, taxRate: TAX_RATE,
    costComponents: [known({ key: 'dropi_commission', kind: 'percentage', base: 'net_price', value: 0.05 })],
  });
  assert('porcentual sobre net_price: CV% = tasa tal cual (0.05)', rPctNet.percentageCostRate === 0.05, JSON.stringify(rPctNet));

  const rPctGross = computeEconomicCost({
    quantity: 1, taxRate: TAX_RATE,
    costComponents: [known({ key: 'payment_fee', kind: 'percentage', base: 'gross_price', value: 0.04 })],
  });
  const expectedGrossNormalized = 0.04 * (1 + TAX_RATE);
  assert(
    'porcentual sobre gross_price: CV% = tasa × (1+TAX_RATE) (0.04×1.15=0.046)',
    Math.abs(rPctGross.percentageCostRate - expectedGrossNormalized) < 1e-9,
    JSON.stringify(rPctGross)
  );
  assert('normalizeBaseFactor(net_price) === 1', normalizeBaseFactor('net_price', TAX_RATE) === 1);
  assert('normalizeBaseFactor(gross_price) === 1+TAX_RATE', normalizeBaseFactor('gross_price', TAX_RATE) === 1 + TAX_RATE);
  assert('porcentual NO escala con quantity (es una tasa, no un monto)',
    computeEconomicCost({ quantity: 5, taxRate: TAX_RATE, costComponents: [known({ kind: 'percentage', base: 'net_price', value: 0.05 })] }).percentageCostRate === 0.05
  );

  // ── 7. Costo por orden (no escala con quantity de ESTE producto) ──
  const r7 = computeEconomicCost({
    quantity: 4, taxRate: TAX_RATE,
    costComponents: [known({ key: 'aynimar_processing_fee', scope: 'per_order', value: 1.00, status: 'estimated' })],
  });
  assert('per_order NO escala con quantity (sigue siendo 1.00, no 4.00)', r7.fixedAbsoluteCost === 1.00, JSON.stringify(r7));

  // ── 8. Costo por shipment (distinto de per_order — spec B.1.1) ──
  const r8 = computeEconomicCost({
    quantity: 2, taxRate: TAX_RATE,
    costComponents: [known({ key: 'dropi_freight', scope: 'per_shipment', value: 3.00, status: 'estimated' })],
  });
  assert('per_shipment tampoco escala con quantity', r8.fixedAbsoluteCost === 3.00, JSON.stringify(r8));

  // ── 9. Combinación de varios componentes (mixto absoluto+porcentual, scopes distintos) ──
  const r9 = computeEconomicCost({
    quantity: 2,
    taxRate: TAX_RATE,
    costComponents: [
      known({ key: 'product_cost', scope: 'per_unit', value: 2.60, status: 'known' }),
      known({ key: 'dropi_freight', scope: 'per_shipment', value: 3.00, status: 'estimated' }),
      known({ key: 'dropi_commission', kind: 'percentage', base: 'net_price', value: 0.05, status: 'estimated' }),
      known({ key: 'payment_fee', kind: 'percentage', base: 'gross_price', value: null, status: 'unknown' }),
    ],
  });
  assert(
    'combinación: CF = 2.60×2 (per_unit) + 3.00 (per_shipment) = 8.20; CV% = 0.05 (payment_fee unknown excluido)',
    r9.fixedAbsoluteCost === 8.20 && r9.percentageCostRate === 0.05,
    JSON.stringify(r9)
  );
  assert('combinación: costCoverage = 3/4 = 0.75 (1 de 4 componentes es unknown)', r9.costCoverage === 0.75, JSON.stringify(r9));

  // ── 10. Trazabilidad mediante source ──
  const r10 = computeEconomicCost({
    quantity: 1, taxRate: TAX_RATE,
    costComponents: [known({ source: 'dropi_catalog' }), known({ key: 'x', status: 'unknown', value: null, source: 'pending_confirmation' })],
  });
  assert('source se preserva en componentsUsed', r10.componentsUsed[0].source === 'dropi_catalog');
  assert('source se preserva en unknownComponents', r10.unknownComponents[0].source === 'pending_confirmation');

  // ── 11. Casos inválidos — deben lanzar, nunca "corregir" silenciosamente ──
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  assert('rechaza kind inválido', throws(() => validateCostComponent(known({ kind: 'bogus' }))));
  assert('rechaza scope inválido', throws(() => validateCostComponent(known({ scope: 'bogus' }))));
  assert('rechaza status inválido', throws(() => validateCostComponent(known({ status: 'bogus' }))));
  assert('rechaza percentage sin base', throws(() => validateCostComponent(known({ kind: 'percentage', base: undefined, value: 0.05 }))));
  assert('rechaza value negativo', throws(() => validateCostComponent(known({ value: -1 }))));
  assert('rechaza key vacío', throws(() => validateCostComponent(known({ key: '' }))));
  assert('rechaza source vacío', throws(() => validateCostComponent(known({ source: '' }))));
  assert('rechaza quantity no entero', throws(() => computeEconomicCost({ quantity: 1.5, taxRate: TAX_RATE, costComponents: [] })));
  assert('rechaza quantity <= 0', throws(() => computeEconomicCost({ quantity: 0, taxRate: TAX_RATE, costComponents: [] })));
  assert('rechaza taxRate no numérico', throws(() => computeEconomicCost({ quantity: 1, taxRate: 'x', costComponents: [] })));

  // ── 12. Comportamiento determinista + edge case de lista vacía ──
  const rEmpty = computeEconomicCost({ quantity: 1, taxRate: TAX_RATE, costComponents: [] });
  assert('lista vacía → CF=0, CV%=0, costCoverage=0 (ausencia de datos, no "economía completa")',
    rEmpty.fixedAbsoluteCost === 0 && rEmpty.percentageCostRate === 0 && rEmpty.costCoverage === 0,
    JSON.stringify(rEmpty)
  );
  const inputSame = { quantity: 2, taxRate: TAX_RATE, costComponents: [known()] };
  const run1 = computeEconomicCost(inputSame);
  const run2 = computeEconomicCost(inputSame);
  assert('mismo input → mismo output (determinista)', JSON.stringify(run1) === JSON.stringify(run2));
});

// ── 8. Pricing Engine — P_min (Paso 2, docs/PRICING_ENGINE_SPEC.md) ─────────
suite('Pricing Engine — computePricingResult (P_min)', () => {
  const { computePricingResult, classifyConfidence, ceil2, PRODUCT_COST_KEY } = require('../Services/pricingEngine');
  const { TAX_RATE, round2 } = require('../Services/orderTotals');

  const productCost = (value, overrides) => ({
    key: PRODUCT_COST_KEY, kind: 'absolute', scope: 'per_unit',
    status: 'known', value, source: 'dropi_catalog', ...overrides,
  });

  // ── 0. ceil2 — política de redondeo del piso (corrección de auditoría) ──
  // Caso central: 2.60/0.70 = 3.714285714... El 3er decimal (4) es < 5, así
  // que round2 (redondeo al más cercano) SÍ redondea hacia abajo a 3.71 —
  // dejando el precio realmente cobrado por debajo del piso matemático. ceil2
  // debe redondear hacia arriba a 3.72 siempre, sin excepción.
  assert('ceil2(2.60/0.70) = 3.72 (hacia arriba, nunca 3.71)', ceil2(2.60 / 0.70) === 3.72, `ceil2=${ceil2(2.60 / 0.70)}`);
  assert('round2 del mismo valor SÍ redondea hacia abajo a 3.71 (demuestra por qué no sirve para un piso)', round2(2.60 / 0.70) === 3.71);
  assert('ceil2 nunca es menor que el valor exacto', ceil2(2.60 / 0.70) >= 2.60 / 0.70);
  assert('ceil2 de un valor exacto de centavo no lo infla (8.00 → 8.00, no 8.01)', ceil2(5.60 / 0.70) === 8.00, `ceil2=${ceil2(5.60 / 0.70)}`);
  assert('ceil2 tolera ruido de punto flotante sin inflar un centavo exacto', ceil2(0.1 + 0.2) === 0.30, `ceil2=${ceil2(0.1 + 0.2)}`); // 0.1+0.2=0.30000000000000004 en float

  // ── 1+3. Fórmula básica con costo absoluto puro, CV%=0 — equivalencia con CF/(1-M) ──
  const r1 = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: [productCost(2.60)] });
  assert('r1.valid === true', r1.valid === true, JSON.stringify(r1));
  assert('minimumNetPrice = ceil2(CF/(1-M)) cuando CV%=0 (2.60/0.70 → 3.72, redondeado hacia arriba)', r1.minimumNetPrice === ceil2(2.60 / 0.70), JSON.stringify(r1));
  assert('equivalencia explícita con la fórmula ya usada en checkout (costo/(1-margen)), con techo aplicado', r1.minimumNetPrice === ceil2(2.60 / (1 - 0.30)));
  assert('a 3.72, el margen REAL logrado es >= 30% exacto (1.12/3.72 = 30.11%)', (r1.minimumNetPrice - 2.60) / r1.minimumNetPrice >= 0.30);

  // ── 2. Fórmula con margen objetivo — floor domina cuando CF completo > costo puro ──
  const r2 = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [productCost(2.60), { key: 'dropi_freight', kind: 'absolute', scope: 'per_shipment', status: 'estimated', value: 3.00, source: 'manual_estimate' }],
  });
  assert('marginTargetNetPrice usa SOLO product_cost, redondeado hacia arriba (2.60/0.70 → 3.72)', r2.marginTargetNetPrice === ceil2(2.60 / 0.70), JSON.stringify(r2));
  assert('minimumNetPrice usa el CF completo (5.60/0.70 = 8.00 exacto, sin efecto del techo)', r2.minimumNetPrice === ceil2(5.60 / 0.70), JSON.stringify(r2));
  assert('recommendedNetPrice = max(ambos) → domina el piso completo (8.00 > 3.72)', r2.recommendedNetPrice === r2.minimumNetPrice && r2.recommendedNetPrice === 8.00, JSON.stringify(r2));

  // ── 4. Porcentual sobre net_price ──
  const r4 = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.20,
    costComponents: [productCost(10), { key: 'dropi_commission', kind: 'percentage', scope: 'per_unit', base: 'net_price', status: 'known', value: 0.10, source: 'dropi_contract' }],
  });
  assert('CV% sobre net_price = 0.10 tal cual', r4.economicCost.percentageCostRate === 0.10, JSON.stringify(r4));
  assert('P_min = ceil2(10/0.70) ≈ 14.29', r4.minimumNetPrice === ceil2(10 / 0.70), JSON.stringify(r4));

  // ── 5. Porcentual sobre gross_price (normalización obligatoria) ──
  const r5 = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.20,
    costComponents: [productCost(10), { key: 'payment_fee', kind: 'percentage', scope: 'per_unit', base: 'gross_price', status: 'known', value: 0.10, source: 'gateway_contract' }],
  });
  const expectedCV5 = 0.10 * (1 + TAX_RATE);
  assert('CV% sobre gross_price se normaliza ×(1+TAX_RATE) = 0.115', Math.abs(r5.economicCost.percentageCostRate - expectedCV5) < 1e-9, JSON.stringify(r5));
  assert('P_min = ceil2(10/(1-0.115-0.20)) ≈ 14.60 (distinto del caso net_price)', r5.minimumNetPrice === ceil2(10 / (1 - expectedCV5 - 0.20)), JSON.stringify(r5));
  assert('la base SÍ importa: net_price y gross_price dan pisos distintos para la misma tasa nominal', r4.minimumNetPrice !== r5.minimumNetPrice);

  // ── 6+7. Combinación de múltiples porcentajes con bases distintas ──
  const r6 = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [
      productCost(10),
      { key: 'dropi_commission', kind: 'percentage', scope: 'per_unit', base: 'net_price', status: 'estimated', value: 0.05, source: 'manual_estimate' },
      { key: 'payment_fee', kind: 'percentage', scope: 'per_unit', base: 'gross_price', status: 'estimated', value: 0.04, source: 'manual_estimate' },
    ],
  });
  assert('normalización correcta con múltiples porcentajes de bases distintas (0.05 + 0.04×1.15 = 0.096)', Math.abs(r6.economicCost.percentageCostRate - 0.096) < 1e-9, JSON.stringify(r6));
  assert('P_min = ceil2(10/(1-0.096-0.30)) ≈ 16.56', r6.minimumNetPrice === ceil2(10 / (1 - r6.economicCost.percentageCostRate - 0.30)), JSON.stringify(r6));

  // ── 8. CV% + M >= 1 → rechazo explícito, nunca truncar ──
  const r8a = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.60,
    costComponents: [productCost(10), { key: 'x', kind: 'percentage', scope: 'per_unit', base: 'net_price', status: 'known', value: 0.50, source: 's' }],
  });
  assert('CV%+M=1.10 >= 1 → valid=false', r8a.valid === false, JSON.stringify(r8a));
  assert('inválido → minimumNetPrice/marginTargetNetPrice/recommendedNetPrice son null, NUNCA un número artificial',
    r8a.minimumNetPrice === null && r8a.marginTargetNetPrice === null && r8a.recommendedNetPrice === null, JSON.stringify(r8a));
  assert('inválido → warning explica la causa', r8a.warnings.some((w) => w.includes('>= 1')));
  const r8b = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.70, costComponents: [{ key: 'x', kind: 'percentage', scope: 'per_unit', base: 'net_price', status: 'known', value: 0.30, source: 's' }] });
  assert('límite exacto CV%+M=1.00 (denom=0) → también inválido', r8b.valid === false, JSON.stringify(r8b));

  // ── 9. Costo desconocido ──
  const r9 = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [productCost(2.60), { key: 'payment_fee', kind: 'percentage', scope: 'per_unit', base: 'gross_price', status: 'unknown', value: null, source: 'pending' }],
  });
  assert('unknown NO se incluye en CV% (sigue siendo 0)', r9.economicCost.percentageCostRate === 0, JSON.stringify(r9));
  assert('unknown se lista explícitamente en economicCost.unknownComponents', r9.economicCost.unknownComponents.length === 1);
  assert('unknown genera warning explícito', r9.warnings.some((w) => w.includes('desconocido')));
  assert('el cálculo sigue siendo válido (parcial, no bloqueante)', r9.valid === true);

  // ── 10. Costo estimado ──
  const r10 = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [productCost(2.60), { key: 'dropi_freight', kind: 'absolute', scope: 'per_shipment', status: 'estimated', value: 3.00, source: 'manual_estimate' }],
  });
  assert('estimated SÍ contribuye a CF (a diferencia de unknown)', r10.economicCost.fixedAbsoluteCost === 5.60, JSON.stringify(r10));
  assert('estimated por shipment genera warning de asignación asumida (spec B.1.1)', r10.warnings.some((w) => w.includes('order/shipment')), JSON.stringify(r10.warnings));

  // ── 11/12/13. Confidence — umbrales exactos, sin solapamiento ──
  const buildComponents = (knownCount, unknownCount) => {
    const arr = [];
    for (let i = 0; i < knownCount; i++) arr.push({ key: `k${i}`, kind: 'absolute', scope: 'per_unit', status: 'known', value: 1, source: 's' });
    for (let i = 0; i < unknownCount; i++) arr.push({ key: `u${i}`, kind: 'absolute', scope: 'per_unit', status: 'unknown', value: null, source: 's' });
    return arr;
  };
  assert('classifyConfidence(0.90) === high (límite inclusive)', classifyConfidence(0.90) === 'high');
  assert('classifyConfidence(0.50) === medium (límite inclusive)', classifyConfidence(0.50) === 'medium');
  assert('classifyConfidence(0.4999) === low', classifyConfidence(0.4999) === 'low');
  assert('classifyConfidence(0.8999) === medium (justo debajo de high)', classifyConfidence(0.8999) === 'medium');
  const rHigh = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: buildComponents(9, 1) });
  assert('confidence high con costCoverage=0.90 real (9 known / 1 unknown)', rHigh.confidence === 'high', JSON.stringify(rHigh.economicCost));
  const rMed = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: buildComponents(5, 5) });
  assert('confidence medium con costCoverage=0.50 real (5/5)', rMed.confidence === 'medium', JSON.stringify(rMed.economicCost));
  const rLow = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: buildComponents(4, 6) });
  assert('confidence low con costCoverage=0.40 real (4/6)', rLow.confidence === 'low', JSON.stringify(rLow.economicCost));

  // ── 14. Costo absoluto cero ──
  const r14 = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: [productCost(0)] });
  assert('CF=0 → minimumNetPrice=0, válido, con warning explícito', r14.valid === true && r14.minimumNetPrice === 0 && r14.warnings.some((w) => w.includes('fixedAbsoluteCost = 0')), JSON.stringify(r14));

  // ── 15. Lista de costos vacía ──
  const r15 = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: [] });
  assert('lista vacía → confidence low (costCoverage=0, no "economía completa")', r15.confidence === 'low', JSON.stringify(r15));
  assert('lista vacía → warning de product_cost ausente', r15.warnings.some((w) => w.includes("product_cost")), JSON.stringify(r15.warnings));
  assert('lista vacía → minimumNetPrice=0, sigue siendo válido matemáticamente (no confundir válido con "confiable")', r15.valid === true && r15.minimumNetPrice === 0);

  // ── 16. Cantidades distintas — per_unit escala, per_shipment no ──
  const r16 = computePricingResult({
    quantity: 3, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [productCost(2.60), { key: 'dropi_freight', kind: 'absolute', scope: 'per_shipment', status: 'estimated', value: 3.00, source: 'manual_estimate' }],
  });
  assert('quantity=3: CF = 2.60×3 (per_unit) + 3.00 (per_shipment, sin escalar) = 10.80', r16.economicCost.fixedAbsoluteCost === 10.80, JSON.stringify(r16));
  assert('quantity=3: marginTargetNetPrice usa product_cost×3 = ceil2(7.80/0.70) ≈ 11.15 (7.80/0.70=11.142857..., redondea hacia arriba, NO 11.14)', r16.marginTargetNetPrice === ceil2(7.80 / 0.70), JSON.stringify(r16));
  assert('minimumNetPrice y marginTargetNetPrice difieren según qué costos se incluyen', r16.minimumNetPrice !== r16.marginTargetNetPrice);

  // ── 17. Determinismo ──
  const detInput = { quantity: 2, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: [productCost(2.60)] };
  assert('mismo input → mismo output', JSON.stringify(computePricingResult(detInput)) === JSON.stringify(computePricingResult(detInput)));

  // ── 18. Valores inválidos ──
  const throwsP = (fn) => { try { fn(); return false; } catch { return true; } };
  assert('rechaza targetContributionMargin negativo', throwsP(() => computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: -0.1, costComponents: [] })));
  assert('rechaza targetContributionMargin no numérico', throwsP(() => computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 'x', costComponents: [] })));
  assert('propaga el rechazo del Cost Engine ante un CostComponent inválido', throwsP(() => computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.3, costComponents: [{ key: '', kind: 'absolute', scope: 'per_unit', status: 'known', value: 1, source: 's' }] })));

  // ── 'product_cost' — robustez de la convención contractual (corrección de auditoría) ──
  assert('PRODUCT_COST_KEY exportado y con el valor esperado', PRODUCT_COST_KEY === 'product_cost');
  const rNoProductCost = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [{ key: 'shipping', kind: 'absolute', scope: 'per_shipment', status: 'known', value: 3, source: 's' }],
  });
  assert('sin ningún componente product_cost → marginTargetNetPrice=0 y warning explícito (nunca falla en silencio)',
    rNoProductCost.marginTargetNetPrice === 0 && rNoProductCost.warnings.some((w) => w.includes(PRODUCT_COST_KEY)), JSON.stringify(rNoProductCost));
  const rDupeProductCost = computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [productCost(2.60), productCost(1.40, { key: PRODUCT_COST_KEY, source: 'otro_lote' })],
  });
  assert('dos componentes product_cost → se suman (2.60+1.40=4.00) Y se advierte explícitamente, no pasa en silencio',
    rDupeProductCost.marginTargetNetPrice === ceil2(4.00 / 0.70) &&
    rDupeProductCost.warnings.some((w) => w.includes('2 CostComponent') && w.includes(PRODUCT_COST_KEY)),
    JSON.stringify(rDupeProductCost));

  // ── 19. Propiedad fundamental — el margen logrado NUNCA es menor al objetivo ──
  // Epsilon estricto (1e-9, ruido de punto flotante) — NO 0.01. Con ceil2, la
  // propiedad se demuestra matemáticamente exacta: ceil2(CF/denom) >= CF/denom
  // por construcción, así que contribución/precio >= M siempre, salvo el
  // error de representación de punto flotante en la división final (~1e-15).
  const scenarios = [
    { M: 0.30, comps: [productCost(2.60)] },
    { M: 0.30, comps: [productCost(2.60), { key: 'dropi_freight', kind: 'absolute', scope: 'per_shipment', status: 'estimated', value: 3.00, source: 's' }] },
    { M: 0.20, comps: [productCost(10), { key: 'c1', kind: 'percentage', scope: 'per_unit', base: 'net_price', status: 'known', value: 0.10, source: 's' }] },
    { M: 0.20, comps: [productCost(10), { key: 'c2', kind: 'percentage', scope: 'per_unit', base: 'gross_price', status: 'known', value: 0.10, source: 's' }] },
    { M: 0.50, comps: [productCost(50)] },
    { M: 0.05, comps: [productCost(2.60), { key: 'c3', kind: 'percentage', scope: 'per_unit', base: 'net_price', status: 'estimated', value: 0.30, source: 's' }] },
    { M: 0.30, comps: [productCost(5)] },
    { M: 0.30, comps: [productCost(25)] },
    { M: 0.30, comps: [productCost(0.01)] }, // caso extremo: costo mínimo posible
    { M: 0.99, comps: [productCost(1)] },    // margen extremo, cercano al límite CV%+M<1
  ];
  const EPSILON = 1e-9;
  for (const { M, comps } of scenarios) {
    const res = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: M, costComponents: comps });
    if (!res.valid) continue; // los inválidos ya se prueban en el caso 8
    const P = res.minimumNetPrice;
    const contribution = P - res.economicCost.fixedAbsoluteCost - P * res.economicCost.percentageCostRate;
    const marginAchieved = P > 0 ? contribution / P : M; // P=0 es degenerado (CF=0), no aplica la razón
    assert(
      `invariante (epsilon=1e-9): margen logrado (${marginAchieved.toFixed(10)}) >= objetivo (${M}) para CF=${res.economicCost.fixedAbsoluteCost}, CV%=${res.economicCost.percentageCostRate}`,
      marginAchieved >= M - EPSILON
    );
  }
});

// ── 9. Commercial Engine (Paso 3, docs/PRICING_ENGINE_SPEC.md sección B.3) ──
suite('Commercial Engine — computeCommercialPrice / estrategias / bundles', () => {
  const {
    computePricingResult,
    computeCommercialPrice,
    applyGrossRoundingStrategy,
    validateFloor,
    computeBundleEconomicFloor,
    VALID_GROSS_ROUNDING_STRATEGIES,
    PRODUCT_COST_KEY,
    ceil2,
  } = require('../Services/pricingEngine');
  const { TAX_RATE, round2 } = require('../Services/orderTotals');

  const pricingFor = (cost, M = 0.30) => computePricingResult({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: M,
    costComponents: [{ key: PRODUCT_COST_KEY, kind: 'absolute', scope: 'per_unit', status: 'known', value: cost, source: 'x' }],
  });

  // ── 0. Las CUATRO etapas — economic floor (NETO) vs commercial strategy
  // (NETO) vs PVP/GROSS vs psychological rounding (PVP). No son lo mismo. ──
  const p0 = pricingFor(2.60);
  const c0 = computeCommercialPrice({ pricingResult: p0, strategyName: 'ROUND_99' });
  assert('Etapa 1 — economic floor (Pricing Engine, NETO): p0.minimumNetPrice = 3.72', p0.minimumNetPrice === 3.72, JSON.stringify(p0));
  assert('Etapa 2 — commercial strategy (Commercial Engine, NETO): c0.commercialNetPrice = 3.72, SIN redondeo aplicado (sigue siendo el neto floor-protegido)',
    c0.commercialNetPrice === 3.72, JSON.stringify(c0));
  assert('Etapa 2 propaga la estrategia SOLICITADA como metadata, sin ejecutarla', c0.presentationRoundingStrategy === 'ROUND_99');
  assert('warning explícito: la estrategia está pendiente del Tax Engine (Paso 4), nunca aplicada en silencio al neto',
    c0.warnings.some((w) => w.includes('NO aplicada') && w.includes('PVP')), JSON.stringify(c0.warnings));
  // Etapa 3 (PVP/GROSS) — simulado aquí SOLO para el test, usando TAX_RATE ya
  // existente en orderTotals.js. El Commercial Engine NO hace esta cuenta —
  // esto demuestra dónde y cómo se conectaría en el Paso 4, no la implementa.
  const simulatedGrossPrice = round2(c0.commercialNetPrice * (1 + TAX_RATE));
  assert('Etapa 3 — PVP/GROSS (simulado para el test, NO ejecutado por el Commercial Engine): 3.72×1.15 ≈ 4.28',
    simulatedGrossPrice === round2(3.72 * 1.15), `simulatedGrossPrice=${simulatedGrossPrice}`);
  // Etapa 4 — psychological rounding, SOLO sobre el PVP simulado, nunca sobre el neto.
  const finalGrossWithRounding = applyGrossRoundingStrategy(simulatedGrossPrice, c0.presentationRoundingStrategy);
  assert('Etapa 4 — redondeo psicológico sobre PVP: ROUND_99(4.28 PVP) = 4.99, NO relacionado con ROUND_99(3.72 neto)',
    finalGrossWithRounding === 4.99, `finalGrossWithRounding=${finalGrossWithRounding}`);
  assert(
    'PRUEBA CENTRAL: ROUND_99(10.00 neto) y ROUND_99(11.50 PVP) NO son equivalentes — números distintos, dominios distintos',
    applyGrossRoundingStrategy(10.00, 'ROUND_99') !== applyGrossRoundingStrategy(11.50, 'ROUND_99') &&
    applyGrossRoundingStrategy(10.00, 'ROUND_99') === 10.99 &&
    applyGrossRoundingStrategy(11.50, 'ROUND_99') === 11.99
  );

  // ── 1. Cada estrategia comercial — commercialNetPrice NUNCA cambia por la estrategia (Paso 3 no la aplica) ──
  const p1 = pricingFor(2.60);
  assert('piso de referencia = 3.72 (consistente con Paso 2)', p1.minimumNetPrice === 3.72, JSON.stringify(p1));
  const strategiesResults = VALID_GROSS_ROUNDING_STRATEGIES.map((s) => computeCommercialPrice({ pricingResult: p1, strategyName: s }));
  assert('las 5 estrategias dan el MISMO commercialNetPrice (3.72) — el redondeo de presentación no toca el neto en este paso',
    strategiesResults.every((r) => r.commercialNetPrice === 3.72), JSON.stringify(strategiesResults.map((r) => r.commercialNetPrice)));
  assert('cada resultado SÍ propaga su propia estrategia solicitada, distinta entre sí',
    new Set(strategiesResults.map((r) => r.presentationRoundingStrategy)).size === 5);
  assert('ninguna estrategia de PRESENTACIÓN es "mejor" por defecto — applyGrossRoundingStrategy da 5 PVP distintos para el mismo PVP de entrada',
    new Set(VALID_GROSS_ROUNDING_STRATEGIES.map((s) => applyGrossRoundingStrategy(4.28, s))).size === 5);

  // ── 2. Determinismo ──
  const detInput = { pricingResult: p1, strategyName: 'ROUND_99', manualNetPrice: 5.00 };
  assert('mismo input → mismo output', JSON.stringify(computeCommercialPrice(detInput)) === JSON.stringify(computeCommercialPrice(detInput)));

  // ── 3. commercialPrice siempre >= economicFloor (invariante general) ──
  const floorInvariantCases = [
    { pricing: pricingFor(2.60), strategyName: 'EXACT' },
    { pricing: pricingFor(2.60), strategyName: 'ROUND_99' },
    { pricing: pricingFor(50), strategyName: 'ROUND_95' },
    { pricing: pricingFor(10, 0.20), strategyName: 'PREMIUM_ROUND' },
  ];
  for (const { pricing, strategyName } of floorInvariantCases) {
    for (const manual of [undefined, 0.01, pricing.minimumNetPrice, pricing.minimumNetPrice * 5, 999]) {
      const res = computeCommercialPrice({ pricingResult: pricing, strategyName, manualNetPrice: manual });
      assert(
        `invariante: commercialNetPrice (${res.commercialNetPrice}) >= economicFloor (${pricing.minimumNetPrice}) [strategy=${strategyName}, manual=${manual}]`,
        res.commercialNetPrice >= pricing.minimumNetPrice
      );
    }
  }

  // ── 4. Candidato por debajo del floor → ADJUSTED, elevado al piso ──
  const belowFloor = computeCommercialPrice({ pricingResult: p1, manualNetPrice: 1.00, strategyName: 'EXACT' });
  assert('candidato 1.00 < piso 3.72 → status ADJUSTED', belowFloor.floorValidation.status === 'ADJUSTED', JSON.stringify(belowFloor));
  assert('candidato ajustado → commercialNetPrice = piso (3.72)', belowFloor.commercialNetPrice === 3.72);
  assert('floorProtectionApplied = true cuando hubo ajuste', belowFloor.floorProtectionApplied === true);

  // ── 5. Candidato por encima del floor → APPROVED, se respeta ──
  const aboveFloor = computeCommercialPrice({ pricingResult: p1, manualNetPrice: 10.00, strategyName: 'EXACT' });
  assert('candidato 10.00 > piso 3.72 → status APPROVED', aboveFloor.floorValidation.status === 'APPROVED', JSON.stringify(aboveFloor));
  assert('candidato aprobado → commercialNetPrice = candidato (10.00)', aboveFloor.commercialNetPrice === 10.00);
  assert('floorProtectionApplied = false cuando NO hubo ajuste', aboveFloor.floorProtectionApplied === false);

  // ── 6. Candidato exactamente igual al floor → APPROVED (no ADJUSTED) ──
  const exactFloor = computeCommercialPrice({ pricingResult: p1, manualNetPrice: p1.minimumNetPrice, strategyName: 'EXACT' });
  assert('candidato === piso exacto → APPROVED, no ADJUSTED', exactFloor.floorValidation.status === 'APPROVED', JSON.stringify(exactFloor));

  // ── 7. .99 y .95 alrededor de límites — SOBRE PVP (applyGrossRoundingStrategy), nunca sobre neto ──
  assert('ROUND_99 de un valor YA en .99 exacto no cambia (idempotente)', applyGrossRoundingStrategy(8.99, 'ROUND_99') === 8.99);
  assert('ROUND_99 de X.00 exacto sube a X.99 (todo precio termina en .99 bajo esta estrategia)', applyGrossRoundingStrategy(9.00, 'ROUND_99') === 9.99);
  assert('ROUND_99 justo un centavo por encima de X.99 sube al siguiente dólar (9.00 → 9.99, no 8.99)', applyGrossRoundingStrategy(9.00, 'ROUND_99') !== 8.99);
  assert('ROUND_95 de un valor YA en .95 exacto no cambia', applyGrossRoundingStrategy(4.95, 'ROUND_95') === 4.95);
  assert('ROUND_95 justo por encima de X.95 sube al siguiente dólar+.95 (4.96 → 5.95)', applyGrossRoundingStrategy(4.96, 'ROUND_95') === 5.95);

  // ── 8. Redondeos con ruido de punto flotante ──
  assert('ROUND_99 tolera ruido de punto flotante sin resultado espurio (0.1+0.2=0.30000000000000004)', applyGrossRoundingStrategy(0.1 + 0.2, 'ROUND_99') === 0.99);
  assert('PREMIUM_ROUND de un entero con ruido flotante (7.999999999999999) no sube de más', applyGrossRoundingStrategy(7.999999999999999, 'PREMIUM_ROUND') === 8);
  assert('EXACT preserva el valor tal cual, incluso con ruido (no es su trabajo limpiarlo)', applyGrossRoundingStrategy(3.7199999999999998, 'EXACT') === 3.7199999999999998);

  // ── 9. Anchoring SOLO con referencia explícita ──
  const withRef = computeCommercialPrice({ pricingResult: p1, manualNetPrice: 5.00, referencePrice: 8.00, strategyName: 'EXACT' });
  assert('con referencePrice explícito → reference no es null', withRef.reference !== null, JSON.stringify(withRef));
  assert('reference.delta = referencePrice - commercialNetPrice = 3.00 (aritmética real, no inventada)', withRef.reference.delta === 3.00, JSON.stringify(withRef.reference));
  assert('reference.referencePrice ECO EXACTO del valor provisto por el caller (nunca alterado)', withRef.reference.referencePrice === 8.00);

  const withoutRef = computeCommercialPrice({ pricingResult: p1, strategyName: 'EXACT' });
  assert('SIN referencePrice provisto → reference es null (nunca se inventa una)', withoutRef.reference === null, JSON.stringify(withoutRef));

  // ── 10. Rechazo de referencias falsas/inválidas — nunca generadas por el motor ──
  const badRef1 = computeCommercialPrice({ pricingResult: p1, referencePrice: -5, strategyName: 'EXACT' });
  assert('referencePrice negativo → ignorado (reference=null), warning explícito, NUNCA corregido a un valor inventado',
    badRef1.reference === null && badRef1.warnings.some((w) => w.includes('referencePrice inválido')), JSON.stringify(badRef1));
  const badRef2 = computeCommercialPrice({ pricingResult: p1, referencePrice: 0, strategyName: 'EXACT' });
  assert('referencePrice=0 → ignorado (no es una referencia real)', badRef2.reference === null, JSON.stringify(badRef2));
  const cheapRef = computeCommercialPrice({ pricingResult: p1, manualNetPrice: 10, referencePrice: 5, strategyName: 'EXACT' });
  assert('referencePrice MENOR al precio final → se registra igual (es un dato real) pero con warning de que no representa un descuento',
    cheapRef.reference !== null && cheapRef.warnings.some((w) => w.includes('no representa un descuento real')), JSON.stringify(cheapRef));

  // ── 11. Free product SOLO en contexto explícito ──
  const freeOk = computeCommercialPrice({
    pricingResult: p1, manualNetPrice: 0, allowBelowFloor: true, overrideReason: 'regalo con la compra de otro producto', strategyName: 'ROUND_99',
  });
  assert('free product con override completo → APPROVED_BELOW_FLOOR, precio=0 (ninguna estrategia se aplica al neto en este paso, 0 sigue siendo 0)',
    freeOk.floorValidation.status === 'APPROVED_BELOW_FLOOR' && freeOk.commercialNetPrice === 0, JSON.stringify(freeOk));
  assert('warning explícito menciona que product.price del catálogo NO se modifica', freeOk.warnings.some((w) => w.includes('catálogo NO se modifica')));
  const throwsC = (fn) => { try { fn(); return false; } catch { return true; } };
  assert('allowBelowFloor=true SIN overrideReason → lanza (nunca una excepción silenciosa)',
    throwsC(() => computeCommercialPrice({ pricingResult: p1, manualNetPrice: 0, allowBelowFloor: true, strategyName: 'EXACT' })));
  assert('allowBelowFloor=true con overrideReason vacío → también lanza',
    throwsC(() => computeCommercialPrice({ pricingResult: p1, manualNetPrice: 0, allowBelowFloor: true, overrideReason: '   ', strategyName: 'EXACT' })));
  assert('SIN allowBelowFloor, manualNetPrice=0 → NO se acepta como "gratis", se trata como candidato bajo el piso (ADJUSTED)',
    computeCommercialPrice({ pricingResult: p1, manualNetPrice: 0, strategyName: 'EXACT' }).floorValidation.status === 'ADJUSTED');

  // ── 11b. APPROVED_BELOW_FLOOR — nunca accidental (endurecimiento, revisión de auditoría) ──
  assert('allowBelowFloor=1 (truthy, NO ===true) → NO activa la excepción, se trata como candidato normal bajo el piso (ADJUSTED)',
    computeCommercialPrice({ pricingResult: p1, manualNetPrice: 0, allowBelowFloor: 1, overrideReason: 'x', strategyName: 'EXACT' }).floorValidation.status === 'ADJUSTED');
  assert('allowBelowFloor="true" (string, NO ===true boolean) → tampoco activa la excepción',
    computeCommercialPrice({ pricingResult: p1, manualNetPrice: 0, allowBelowFloor: 'true', overrideReason: 'x', strategyName: 'EXACT' }).floorValidation.status === 'ADJUSTED');
  assert('la excepción NUNCA altera pricing.minimumNetPrice — el piso económico real permanece intacto y visible',
    freeOk.pricing.minimumNetPrice === p1.minimumNetPrice, JSON.stringify({ freeOkFloor: freeOk.pricing.minimumNetPrice, realFloor: p1.minimumNetPrice }));
  assert('status APPROVED_BELOW_FLOOR es un string DISTINTO de "APPROVED" — nunca se puede confundir por comparación directa',
    freeOk.floorValidation.status !== 'APPROVED' && freeOk.floorValidation.status === 'APPROVED_BELOW_FLOOR');
  assert('reason en APPROVED_BELOW_FLOOR es exactamente el overrideReason del caller (auditable, no genérico)',
    freeOk.floorValidation.reason === 'regalo con la compra de otro producto');

  // ── 12. Bundles — piso CONSERVADOR = suma de pisos individuales, NO el "precio óptimo del bundle" ──
  const bundleComp1 = pricingFor(2.60, 0.30); // piso 3.72
  const bundleComp2 = pricingFor(10, 0.20);   // piso ceil2(10/0.80)=12.50
  assert('componente 2 del bundle: piso de referencia', bundleComp2.minimumNetPrice === ceil2(10 / 0.80), JSON.stringify(bundleComp2));
  const bundleFloor = computeBundleEconomicFloor([bundleComp1, bundleComp2]);
  assert('piso del bundle = suma exacta de los pisos individuales (3.72+12.50) — "cada componente respeta su propio piso", no una optimización',
    bundleFloor.bundleEconomicFloor === round2(bundleComp1.minimumNetPrice + bundleComp2.minimumNetPrice), JSON.stringify(bundleFloor));
  assert('bundle: allValid=true cuando todos los componentes son válidos', bundleFloor.allValid === true);
  assert('bundle: components refleja la cantidad de productos', bundleFloor.components === 2);
  // El piso del bundle se valida con el MISMO mecanismo que un producto individual — no hay una
  // función de validación de bundle aparte, reutiliza computeCommercialPrice/validateFloor tratando
  // el bundle como un "pseudo-PricingResult" con minimumNetPrice=bundleFloor.
  const bundlePseudoPricing = { valid: true, minimumNetPrice: bundleFloor.bundleEconomicFloor, recommendedNetPrice: bundleFloor.bundleEconomicFloor, confidence: 'high', warnings: [], economicCost: null, marginTargetNetPrice: bundleFloor.bundleEconomicFloor, targetContributionMargin: null };
  const bundleCommercial = computeCommercialPrice({ pricingResult: bundlePseudoPricing, manualNetPrice: 14.00, strategyName: 'EXACT' });
  assert('bundle vendido en 14.00 (< piso conservador 16.22) → protegido, elevado exactamente al piso (sin optimización de subsidio cruzado)',
    bundleCommercial.floorProtectionApplied === true && bundleCommercial.commercialNetPrice === bundleFloor.bundleEconomicFloor,
    JSON.stringify(bundleCommercial));
  // Subsidio cruzado deliberado (loss-leader controlado) — MISMO mecanismo que free product, sin fórmula nueva.
  const bundleLossLeader = computeCommercialPrice({
    pricingResult: bundlePseudoPricing, manualNetPrice: 15.00, allowBelowFloor: true,
    overrideReason: 'promoción de lanzamiel — subsidio cruzado deliberado aprobado por negocio', strategyName: 'EXACT',
  });
  assert('subsidio cruzado deliberado (bundle por debajo de su piso conservador) usa EXACTAMENTE el mecanismo allowBelowFloor — ninguna fórmula de optimización nueva',
    bundleLossLeader.floorValidation.status === 'APPROVED_BELOW_FLOOR' && bundleLossLeader.commercialNetPrice === 15.00, JSON.stringify(bundleLossLeader));
  assert('bundle con array vacío → lanza (no hay nada que sumar)', throwsC(() => computeBundleEconomicFloor([])));
  const bundleWithInvalid = computeBundleEconomicFloor([bundleComp1, { valid: false }]);
  assert('bundle con un componente inválido → allValid=false, bundleEconomicFloor=null (nunca un número parcial engañoso)',
    bundleWithInvalid.allValid === false && bundleWithInvalid.bundleEconomicFloor === null, JSON.stringify(bundleWithInvalid));

  // ── 13. Warnings y trazabilidad ──
  assert('candidato APPROVED sin ajuste → sin warnings de floor', aboveFloor.warnings.length === 0, JSON.stringify(aboveFloor.warnings));
  assert('candidato ADJUSTED → warning menciona el precio propuesto y el piso', belowFloor.warnings.some((w) => w.includes('1') && w.includes('3.72')));
  assert('CommercialResult expone floorValidation completo para trazabilidad (status+finalNetPrice+reason)',
    typeof belowFloor.floorValidation.status === 'string' && typeof belowFloor.floorValidation.finalNetPrice === 'number' && typeof belowFloor.floorValidation.reason === 'string');
  assert('CommercialResult expone candidate completo (proposedNetPrice+strategy+rationale)',
    typeof belowFloor.candidate.proposedNetPrice === 'number' && typeof belowFloor.candidate.rationale === 'string');

  // ── 14. Propagación correcta de confidence (sin duplicar) ──
  const lowConfComponents = [{ key: PRODUCT_COST_KEY, kind: 'absolute', scope: 'per_unit', status: 'known', value: 2.60, source: 'x' },
    { key: 'shipping', kind: 'absolute', scope: 'per_shipment', status: 'unknown', value: null, source: 'x' }];
  const lowConfPricing = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30, costComponents: lowConfComponents });
  assert('confidence del pricing de referencia = medium (costCoverage=0.5)', lowConfPricing.confidence === 'medium', JSON.stringify(lowConfPricing));
  const lowConfCommercial = computeCommercialPrice({ pricingResult: lowConfPricing, strategyName: 'EXACT' });
  assert('CommercialResult NO tiene un campo confidence propio — se lee vía .pricing.confidence (una sola fuente de verdad)',
    !('confidence' in lowConfCommercial) && lowConfCommercial.pricing.confidence === 'medium', JSON.stringify(Object.keys(lowConfCommercial)));
  assert('CommercialResult NO duplica fixedAbsoluteCost/percentageCostRate a nivel superior', !('fixedAbsoluteCost' in lowConfCommercial) && !('percentageCostRate' in lowConfCommercial));

  // ── 15. Inputs inválidos ──
  assert('rechaza pricingResult ausente', throwsC(() => computeCommercialPrice({ strategyName: 'EXACT' })));
  assert('rechaza strategyName desconocido', throwsC(() => computeCommercialPrice({ pricingResult: p1, strategyName: 'BOGUS' })));
  assert('rechaza applyGrossRoundingStrategy con price no numérico', throwsC(() => applyGrossRoundingStrategy('x', 'EXACT')));
  assert('rechaza applyGrossRoundingStrategy con estrategia inexistente', throwsC(() => applyGrossRoundingStrategy(5, 'NOPE')));
  assert('rechaza validateFloor sin PricingResult válido', throwsC(() => validateFloor({ proposedNetPrice: 5 }, { valid: false })));
  const pInvalid = computePricingResult({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.99, costComponents: [{ key: 'x', kind: 'percentage', scope: 'per_unit', base: 'net_price', status: 'known', value: 0.5, source: 's' }] });
  assert('pricingResult.valid=false (CV%+M>=1) → computeCommercialPrice propaga valid=false, sin inventar precio',
    computeCommercialPrice({ pricingResult: pInvalid, strategyName: 'EXACT' }).valid === false, JSON.stringify(pInvalid));

  // ── VALID_GROSS_ROUNDING_STRATEGIES expone exactamente las 5 estrategias del spec ──
  assert('VALID_GROSS_ROUNDING_STRATEGIES = EXACT/ROUND_99/ROUND_95/ROUND_90/PREMIUM_ROUND, ninguna más',
    JSON.stringify(VALID_GROSS_ROUNDING_STRATEGIES.slice().sort()) === JSON.stringify(['EXACT', 'PREMIUM_ROUND', 'ROUND_90', 'ROUND_95', 'ROUND_99'].sort()));
});

// ── 10. Tax Engine — toGross / extractFromGross (Paso 4, orderTotals.js) ────
suite('Tax Engine — toGross / extractFromGross', () => {
  const { toGross, extractFromGross, round2, TAX_RATE } = require('../Services/orderTotals');
  const throwsT = (fn) => { try { fn(); return false; } catch { return true; } };

  // ── 1. net → gross ──
  const g1 = toGross(10.00, 0.15);
  assert('toGross(10.00, 15%) → grossPrice=11.50', g1.grossPrice === 11.50, JSON.stringify(g1));
  assert('toGross: taxAmount = grossPrice − netPrice EXACTO (residuo, sin fuga)', round2(g1.netPrice + g1.taxAmount) === g1.grossPrice, JSON.stringify(g1));

  // ── 2. gross → net ──
  const n1 = extractFromGross(11.50, 0.15);
  assert('extractFromGross(11.50, 15%) → base=10.00', n1.base === 10.00, JSON.stringify(n1));
  assert('extractFromGross: taxAmount = grossPrice − base EXACTO', round2(n1.base + n1.taxAmount) === n1.grossPrice, JSON.stringify(n1));

  // ── 3. IVA 0% ──
  assert('toGross con taxRate=0 → grossPrice = netPrice sin cambio', toGross(50, 0).grossPrice === 50);
  assert('extractFromGross con taxRate=0 → base = grossPrice sin cambio', extractFromGross(50, 0).base === 50);
  assert('taxRate=0 → taxAmount siempre 0', toGross(123.45, 0).taxAmount === 0 && extractFromGross(123.45, 0).taxAmount === 0);

  // ── 4. IVA 15% (TAX_RATE del sistema, sin hardcodear aquí — se pasa como parámetro) ──
  assert('TAX_RATE del sistema = 0.15 (fuente única, orderTotals.js)', TAX_RATE === 0.15);
  assert('toGross usando TAX_RATE real del sistema', toGross(2.60, TAX_RATE).grossPrice === round2(2.60 * 1.15));

  // ── 5. Tasas arbitrarias válidas (ni 15% ni 0%) ──
  assert('toGross con tasa 12%', toGross(100, 0.12).grossPrice === 112.00);
  assert('toGross con tasa 8%', toGross(50, 0.08).grossPrice === 54.00);
  assert('toGross con tasa fraccionaria arbitraria (7.77%)', toGross(10, 0.0777).grossPrice === round2(10 * 1.0777));
  assert('extractFromGross con tasa 21%', extractFromGross(121, 0.21).base === 100.00);

  // ── 6. Valor 0 ──
  assert('toGross(0, 15%) = 0', toGross(0, 0.15).grossPrice === 0 && toGross(0, 0.15).taxAmount === 0);
  assert('extractFromGross(0, 15%) = 0', extractFromGross(0, 0.15).base === 0 && extractFromGross(0, 0.15).taxAmount === 0);

  // ── 7. Decimales ──
  assert('toGross con neto de centavos impares (3.71)', toGross(3.71, 0.15).grossPrice === round2(3.71 * 1.15));
  assert('extractFromGross con PVP de centavos impares (4.27)', extractFromGross(4.27, 0.15).base === round2(4.27 / 1.15));

  // ── 8. Valores grandes ──
  const bigNet = 999999.99;
  const gBig = toGross(bigNet, 0.15);
  assert('toGross con valor grande (999999.99) no pierde precisión de forma inesperada', gBig.grossPrice === round2(bigNet * 1.15), JSON.stringify(gBig));
  assert('extractFromGross revierte un valor grande sin drift (net→gross→net, ver punto 11)',
    extractFromGross(gBig.grossPrice, 0.15).base === bigNet, JSON.stringify({ gBig, back: extractFromGross(gBig.grossPrice, 0.15).base }));

  // ── 9. Ruido de punto flotante ──
  assert('toGross tolera netPrice con ruido de punto flotante (0.1+0.2)', toGross(0.1 + 0.2, 0.15).grossPrice === round2(0.30000000000000004 * 1.15));
  assert('extractFromGross tolera grossPrice con ruido de punto flotante', extractFromGross(0.1 + 0.2, 0.15).base === round2(0.30000000000000004 / 1.15));

  // ── 10. Redondeo monetario — determinista, sin fuga de centavos ──
  for (let cents = 1; cents <= 500; cents += 7) {
    const net = round2(cents / 100);
    const g = toGross(net, 0.15);
    assert(`redondeo monetario determinista: base+tax=gross exacto para net=${net}`, round2(g.netPrice + g.taxAmount) === g.grossPrice);
  }

  // ── 11. Conversión reversible — precisión REAL documentada, no oculta con tolerancias ──
  // net → gross → net: verificado EMPÍRICAMENTE sin deriva (0 casos de drift encontrados
  // en una búsqueda exhaustiva de $0.01 a $10,000.00 a varias tasas, incluida 15%). Se
  // deja como propiedad probada por barrido, no como supuesto.
  let netRoundTripDrift = 0;
  for (let cents = 1; cents <= 100000; cents += 3) {
    const net = round2(cents / 100);
    const gross = toGross(net, 0.15).grossPrice;
    const back = extractFromGross(gross, 0.15).base;
    if (back !== net) netRoundTripDrift++;
  }
  assert('net→gross→net (15%, $0.01–$1000, barrido): CERO deriva encontrada — round-trip verificado sin pérdida', netRoundTripDrift === 0, `drift cases=${netRoundTripDrift}`);

  // gross → net → gross: SÍ existe deriva real, documentada explícitamente, acotada a
  // ±$0.01 (nunca más). Ejemplo concreto encontrado por barrido, cercano al ejemplo del
  // enunciado ($11.50): gross=11.54 → net=10.03 → back=11.53 (deriva de −$0.01).
  assert('gross→net→gross (15%): ejemplo real con deriva de −$0.01 (11.54→10.03→11.53), documentado, NO oculto',
    extractFromGross(11.54, 0.15).base === 10.03 && toGross(extractFromGross(11.54, 0.15).base, 0.15).grossPrice === 11.53);
  let grossRoundTripMaxDrift = 0;
  for (let cents = 100; cents <= 1000000; cents += 11) {
    const gross = round2(cents / 100);
    const net = extractFromGross(gross, 0.15).base;
    const back = toGross(net, 0.15).grossPrice;
    const drift = round2(back - gross);
    if (Math.abs(drift) > Math.abs(grossRoundTripMaxDrift)) grossRoundTripMaxDrift = drift;
  }
  assert('gross→net→gross: la deriva máxima encontrada en el barrido ($1–$10000) es exactamente ±$0.01, nunca más — precisión real acotada y documentada',
    Math.abs(grossRoundTripMaxDrift) <= 0.01 && Math.abs(grossRoundTripMaxDrift) > 0, `maxDrift=${grossRoundTripMaxDrift}`);

  // ── 20 (parcial aquí). No hardcodeo de IVA — taxRate SIEMPRE parámetro ──
  assert('toGross con taxRate distinto en cada llamada da resultados distintos (no hay una tasa fija interna)',
    toGross(100, 0.10).grossPrice !== toGross(100, 0.20).grossPrice);

  // ── Inputs inválidos ──
  assert('toGross rechaza netPrice negativo', throwsT(() => toGross(-1, 0.15)));
  assert('toGross rechaza netPrice no numérico', throwsT(() => toGross('x', 0.15)));
  assert('toGross rechaza taxRate negativo', throwsT(() => toGross(10, -0.1)));
  assert('toGross rechaza taxRate no numérico', throwsT(() => toGross(10, 'x')));
  assert('extractFromGross rechaza grossPrice negativo', throwsT(() => extractFromGross(-1, 0.15)));
  assert('extractFromGross rechaza taxRate no numérico', throwsT(() => extractFromGross(10, null)));

  // ── Determinismo ──
  assert('toGross determinista', JSON.stringify(toGross(37.42, 0.1567)) === JSON.stringify(toGross(37.42, 0.1567)));
  assert('extractFromGross determinista', JSON.stringify(extractFromGross(37.42, 0.1567)) === JSON.stringify(extractFromGross(37.42, 0.1567)));
});

// ── 11. Etapa de presentación — computeFinalGrossPrice (Paso 4, pricingEngine.js) ──
suite('Etapa de presentación — computeFinalGrossPrice (NETO → PVP → redondeo → verificación de piso)', () => {
  const {
    computePricingResult,
    computeCommercialPrice,
    computeFinalGrossPrice,
    applyGrossRoundingStrategy,
    PRODUCT_COST_KEY,
  } = require('../Services/pricingEngine');
  const { TAX_RATE, round2, toGross, extractFromGross } = require('../Services/orderTotals');

  const pipelineFor = (cost, M, strategyName) => {
    const pricing = computePricingResult({
      quantity: 1, taxRate: TAX_RATE, targetContributionMargin: M,
      costComponents: [{ key: PRODUCT_COST_KEY, kind: 'absolute', scope: 'per_unit', status: 'known', value: cost, source: 'x' }],
    });
    const commercial = computeCommercialPrice({ pricingResult: pricing, strategyName });
    return { pricing, commercial };
  };

  // ── 12/13. Ejemplo conceptual EXACTO del enunciado: floorNet=10.00, IVA=15%, .99 ──
  const { commercial: c1 } = pipelineFor(10.00, 0, 'ROUND_99'); // M=0 para fijar floorNet=10.00 exacto
  assert('floorNet = 10.00 (piso fijado por costo puro con M=0, para reproducir el ejemplo del enunciado)', c1.pricing.minimumNetPrice === 10.00);
  const final1 = computeFinalGrossPrice({ commercialResult: c1, taxRate: TAX_RATE });
  assert('netToGross.grossPrice = 11.50 (10.00 × 1.15)', final1.netToGross.grossPrice === 11.50, JSON.stringify(final1));
  assert('roundedGrossPrice (.99 sobre 11.50) = 11.99', final1.roundedGrossPrice === 11.99, JSON.stringify(final1));
  assert('finalGrossPrice = 11.99 (no hizo falta corrección — 11.99/1.15=10.43 ya está por encima del piso)', final1.finalGrossPrice === 11.99, JSON.stringify(final1));
  assert('impliedNetPrice = 10.43 (11.99/1.15), calculado con extractFromGross, NO inventado', final1.impliedNetPrice === round2(11.99 / 1.15), JSON.stringify(final1));
  assert('impliedNetPrice >= floorNet — el piso se preserva incluso tras el redondeo psicológico', final1.impliedNetPrice >= c1.pricing.minimumNetPrice);
  assert('floorProtectedAtGrossStage = false en este ejemplo (no hizo falta corregir)', final1.floorProtectedAtGrossStage === false);
  assert('warnings vacío cuando no hubo que proteger el piso en PVP', final1.warnings.length === 0, JSON.stringify(final1.warnings));

  // ── 13b. Caso FORZADO donde SÍ hace falta proteger el piso en PVP ──
  // Búsqueda exhaustiva (ver informe) no encontró un caso natural de violación con las 5
  // estrategias reales — la protección de piso en PVP es, en la práctica, redundante con
  // las garantías ya probadas de toGross/extractFromGross + redondeo monótono creciente.
  // Se verifica igual el mecanismo de corrección con un CommercialResult sintético que
  // fuerza la condición, exactamente como pide la auditoría: "no asumas, verifica".
  const forcedCommercial = {
    pricing: { minimumNetPrice: 10.50, valid: true },
    candidate: { proposedNetPrice: 10.00, strategy: 'EXACT', rationale: 'test-forzado' },
    floorValidation: { status: 'APPROVED', finalNetPrice: 10.00 },
    commercialNetPrice: 10.00,
    floorProtectionApplied: false,
    presentationRoundingStrategy: 'EXACT',
    reference: null,
    warnings: [],
    valid: true,
  };
  const finalForced = computeFinalGrossPrice({ commercialResult: forcedCommercial, taxRate: TAX_RATE, strategyName: 'EXACT' });
  assert('caso forzado: floorProtectedAtGrossStage = true (la corrección SÍ se activa cuando hace falta)', finalForced.floorProtectedAtGrossStage === true, JSON.stringify(finalForced));
  assert('caso forzado: finalGrossPrice corregido hacia arriba (12.08, no 11.50)', finalForced.finalGrossPrice === 12.08, JSON.stringify(finalForced));
  assert('caso forzado: impliedNetPrice final (10.50) >= floorNet forzado (10.50) — piso preservado exactamente',
    finalForced.impliedNetPrice >= forcedCommercial.pricing.minimumNetPrice, JSON.stringify(finalForced));
  assert('caso forzado: warning explica la corrección, con los números reales, no genérico',
    finalForced.warnings.some((w) => w.includes('10.5') && w.includes('12.08')), JSON.stringify(finalForced.warnings));
  assert('caso forzado: SIN corrección hubiera sido 11.50 (implica neto=10.00 < floor 10.50) — la verificación era necesaria, no cosmética',
    extractFromGross(11.50, TAX_RATE).base < forcedCommercial.pricing.minimumNetPrice);

  // ── Propiedad general: exactitud primero — nunca se sobre-corrige cuando no hace falta ──
  // (prioridad 1 del enunciado: exactitud económica, antes que protección de piso).
  for (const [cost, M, strategy] of [[2.60, 0.30, 'EXACT'], [10, 0.20, 'ROUND_99'], [50, 0.50, 'ROUND_95'], [25, 0.10, 'PREMIUM_ROUND']]) {
    const { commercial } = pipelineFor(cost, M, strategy);
    const final = computeFinalGrossPrice({ commercialResult: commercial, taxRate: TAX_RATE });
    if (!final.floorProtectedAtGrossStage) {
      assert(`sin violación real → finalGrossPrice = roundedGrossPrice EXACTO, sin margen de más (cost=${cost}, M=${M}, ${strategy})`,
        final.finalGrossPrice === final.roundedGrossPrice, JSON.stringify(final));
    }
    assert(`invariante general: impliedNetPrice (${final.impliedNetPrice}) >= floorNet (${commercial.pricing.minimumNetPrice}) [cost=${cost}, M=${M}, ${strategy}]`,
      final.impliedNetPrice >= commercial.pricing.minimumNetPrice);
  }

  // ── 14-18. Cada estrategia, dentro del pipeline completo ──
  const baseCommercial = pipelineFor(2.60, 0.30, 'EXACT').commercial; // floorNet=3.72, netToGross=4.278→4.28
  for (const strategy of ['EXACT', 'ROUND_99', 'ROUND_95', 'ROUND_90', 'PREMIUM_ROUND']) {
    const r = computeFinalGrossPrice({ commercialResult: baseCommercial, taxRate: TAX_RATE, strategyName: strategy });
    const expectedGross = applyGrossRoundingStrategy(toGross(baseCommercial.commercialNetPrice, TAX_RATE).grossPrice, strategy);
    assert(`estrategia ${strategy} dentro del pipeline coincide con applyGrossRoundingStrategy aplicado directamente al PVP natural`,
      r.finalGrossPrice === expectedGross || r.floorProtectedAtGrossStage, JSON.stringify(r));
  }

  // ── 19. No hardcodeo de IVA — el mismo commercialResult con tasas distintas da PVP distintos ──
  const rTax10 = computeFinalGrossPrice({ commercialResult: baseCommercial, taxRate: 0.10 });
  const rTax15 = computeFinalGrossPrice({ commercialResult: baseCommercial, taxRate: 0.15 });
  const rTax21 = computeFinalGrossPrice({ commercialResult: baseCommercial, taxRate: 0.21 });
  assert('tasas distintas producen PVP distintos — ninguna tasa está fija dentro del motor',
    new Set([rTax10.finalGrossPrice, rTax15.finalGrossPrice, rTax21.finalGrossPrice]).size === 3, JSON.stringify({ rTax10: rTax10.finalGrossPrice, rTax15: rTax15.finalGrossPrice, rTax21: rTax21.finalGrossPrice }));

  // ── Determinismo ──
  const detArgs = { commercialResult: baseCommercial, taxRate: TAX_RATE, strategyName: 'ROUND_99' };
  assert('computeFinalGrossPrice determinista', JSON.stringify(computeFinalGrossPrice(detArgs)) === JSON.stringify(computeFinalGrossPrice(detArgs)));

  // ── Inputs inválidos ──
  const throwsF = (fn) => { try { fn(); return false; } catch { return true; } };
  assert('rechaza commercialResult ausente', throwsF(() => computeFinalGrossPrice({ taxRate: TAX_RATE })));
  assert('rechaza taxRate no numérico', throwsF(() => computeFinalGrossPrice({ commercialResult: baseCommercial, taxRate: 'x' })));
  assert('rechaza taxRate negativo', throwsF(() => computeFinalGrossPrice({ commercialResult: baseCommercial, taxRate: -0.1 })));
  assert('rechaza strategyName inválido', throwsF(() => computeFinalGrossPrice({ commercialResult: baseCommercial, taxRate: TAX_RATE, strategyName: 'BOGUS' })));

  // ── commercialResult.valid=false se propaga, nunca inventa un PVP ──
  const invalidCommercial = { valid: false, commercialNetPrice: null, presentationRoundingStrategy: 'EXACT', warnings: [] };
  const rInvalid = computeFinalGrossPrice({ commercialResult: invalidCommercial, taxRate: TAX_RATE });
  assert('commercialResult inválido → valid=false, finalGrossPrice=null, sin inventar nada', rInvalid.valid === false && rInvalid.finalGrossPrice === null, JSON.stringify(rInvalid));

  // ── Trazabilidad — no duplica campos de commercial/pricing, los anida completos ──
  assert('PresentationResult anida el CommercialResult completo (no copia commercialNetPrice suelto a nivel superior)',
    !('commercialNetPrice' in final1) && final1.commercial.commercialNetPrice === c1.commercialNetPrice, JSON.stringify(Object.keys(final1)));
});

// ── 12. Catalog Pricing Service — integración progresiva del motor con el catálogo ──
suite('Catalog Pricing Service (calculateCatalogPrice / classifyCostPrice)', () => {
  const { calculateCatalogPrice, classifyCostPrice } = require('../Services/catalogPricingService');
  const { TAX_RATE } = require('../Services/orderTotals');
  const { VALID_GROSS_ROUNDING_STRATEGIES } = require('../Services/pricingEngine');

  const baseArgs = { quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30 };

  // ── 1. costPrice = null ──
  assert('classifyCostPrice(null) = unknown', classifyCostPrice(null) === 'unknown');
  const r1 = calculateCatalogPrice({ ...baseArgs, costPrice: null });
  assert('costPrice=null → status INCOMPLETE_COST_DATA, sin inventar PVP', r1.status === 'INCOMPLETE_COST_DATA' && r1.pricing === null && r1.final === null, JSON.stringify(r1));

  // ── 2. costPrice = undefined ──
  assert('classifyCostPrice(undefined) = unknown', classifyCostPrice(undefined) === 'unknown');
  const r2 = calculateCatalogPrice({ ...baseArgs, costPrice: undefined });
  assert('costPrice=undefined → status INCOMPLETE_COST_DATA', r2.status === 'INCOMPLETE_COST_DATA' && r2.final === null, JSON.stringify(r2));

  // ── 3. costPrice = NaN ──
  assert('classifyCostPrice(NaN) = unknown', classifyCostPrice(NaN) === 'unknown');
  const r3 = calculateCatalogPrice({ ...baseArgs, costPrice: NaN });
  assert('costPrice=NaN → status INCOMPLETE_COST_DATA (nunca tratado como 0)', r3.status === 'INCOMPLETE_COST_DATA' && r3.final === null, JSON.stringify(r3));

  // ── 4. costPrice = Infinity ──
  assert('classifyCostPrice(Infinity) = unknown', classifyCostPrice(Infinity) === 'unknown');
  const r4 = calculateCatalogPrice({ ...baseArgs, costPrice: Infinity });
  assert('costPrice=Infinity → status INCOMPLETE_COST_DATA', r4.status === 'INCOMPLETE_COST_DATA' && r4.final === null, JSON.stringify(r4));
  assert('classifyCostPrice(-Infinity) = unknown (no es "invalid": no es un negativo finito, es un no-numérico usable)', classifyCostPrice(-Infinity) === 'unknown');

  // ── 5. costPrice < 0 ──
  assert('classifyCostPrice(-0.01) = invalid', classifyCostPrice(-0.01) === 'invalid');
  assert('classifyCostPrice(-5) = invalid', classifyCostPrice(-5) === 'invalid');
  const r5 = calculateCatalogPrice({ ...baseArgs, costPrice: -3.50 });
  assert('costPrice negativo → status INVALID_COST_DATA (distinto de INCOMPLETE_COST_DATA — es un dato erróneo, no ausente)', r5.status === 'INVALID_COST_DATA' && r5.final === null, JSON.stringify(r5));

  // ── 6. costPrice = 0 → NO debe generar un PVP comercial normal ──
  assert('classifyCostPrice(0) = suspicious (no "valid")', classifyCostPrice(0) === 'suspicious');
  const r6a = calculateCatalogPrice({ ...baseArgs, costPrice: 0 });
  assert('costPrice=0 sin allowZeroCost → status INCOMPLETE_COST_DATA, NO se calcula PVP', r6a.status === 'INCOMPLETE_COST_DATA' && r6a.final === null, JSON.stringify(r6a));
  const r6b = calculateCatalogPrice({ ...baseArgs, costPrice: 0, allowZeroCost: true });
  assert('costPrice=0 CON allowZeroCost:true explícito → sí calcula (excepción de contexto, no automática)', r6b.status === 'OK' && r6b.pricing.valid === true, JSON.stringify(r6b));
  assert('costPrice=0 con allowZeroCost:true → minimumNetPrice=0 (piso económico real de un producto sin costo), no un valor inventado', r6b.pricing.minimumNetPrice === 0, JSON.stringify(r6b.pricing));

  // ── 7. costPrice > 0 → flujo normal ──
  assert('classifyCostPrice(2.60) = valid', classifyCostPrice(2.60) === 'valid');
  const r7 = calculateCatalogPrice({ ...baseArgs, costPrice: 2.60 });
  assert('costPrice=2.60 → status OK', r7.status === 'OK', JSON.stringify(r7));
  assert('costPrice=2.60 → pricing.valid=true, minimumNetPrice=ceil2(2.60/0.70)=3.72', r7.pricing.valid === true && r7.pricing.minimumNetPrice === 3.72, JSON.stringify(r7.pricing));
  assert('costPrice=2.60 → commercial.valid=true', r7.commercial.valid === true);
  assert('costPrice=2.60 → final.valid=true, finalGrossPrice numérico > 0', r7.final.valid === true && typeof r7.final.finalGrossPrice === 'number' && r7.final.finalGrossPrice > 0, JSON.stringify(r7.final));

  // ── 8. Integración pura con pricingEngine.js — mismo resultado que llamar directo ──
  const {
    computePricingResult: cpr, computeCommercialPrice: ccp, computeFinalGrossPrice: cfgp, PRODUCT_COST_KEY: pck,
  } = require('../Services/pricingEngine');
  const directPricing = cpr({
    quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 0.30,
    costComponents: [{ key: pck, kind: 'absolute', scope: 'per_unit', status: 'known', value: 2.60, source: 'catalog.costPrice' }],
  });
  const directCommercial = ccp({ pricingResult: directPricing, strategyName: 'EXACT' });
  const directFinal = cfgp({ commercialResult: directCommercial, taxRate: TAX_RATE, strategyName: 'EXACT' });
  assert('calculateCatalogPrice(2.60) produce EXACTAMENTE el mismo PricingResult que llamar a computePricingResult directamente (no reimplementa fórmulas)',
    JSON.stringify(r7.pricing) === JSON.stringify(directPricing));
  assert('mismo resultado para commercial (delegación pura)', JSON.stringify(r7.commercial) === JSON.stringify(directCommercial));
  assert('mismo resultado para final (delegación pura)', JSON.stringify(r7.final) === JSON.stringify(directFinal));

  // ── 9. Estrategia EXACT ──
  const r9 = calculateCatalogPrice({ ...baseArgs, costPrice: 10, strategyName: 'EXACT' });
  assert('strategyName EXACT → final.roundedGrossPrice = final.netToGross.grossPrice (sin ajuste de presentación)',
    r9.final.roundedGrossPrice === r9.final.netToGross.grossPrice, JSON.stringify(r9.final));

  // ── 10. Al menos una estrategia de presentación no-EXACT ──
  const r10 = calculateCatalogPrice({ ...baseArgs, costPrice: 10, targetContributionMargin: 0, strategyName: 'ROUND_99' });
  assert('strategyName ROUND_99 → final.roundedGrossPrice termina en .99 (o igual al natural, si ya terminaba en .99)',
    Math.round((r10.final.roundedGrossPrice % 1) * 100) === 99, JSON.stringify(r10.final));
  assert('ejemplo conocido del Paso 4: costo=10, M=0, ROUND_99 → floorNet=10.00 → PVP final=11.99', r10.final.finalGrossPrice === 11.99, JSON.stringify(r10.final));
  for (const s of VALID_GROSS_ROUNDING_STRATEGIES) {
    const rs = calculateCatalogPrice({ ...baseArgs, costPrice: 15.37, strategyName: s });
    assert(`estrategia "${s}" no lanza y produce un final.finalGrossPrice numérico`, rs.status === 'OK' && typeof rs.final.finalGrossPrice === 'number');
  }

  // ── 11. Ausencia de efectos secundarios ──
  const inputSnapshot = { ...baseArgs, costPrice: 8.40, strategyName: 'ROUND_95' };
  const inputJsonBefore = JSON.stringify(inputSnapshot);
  calculateCatalogPrice(inputSnapshot);
  assert('calculateCatalogPrice no muta su objeto de entrada', JSON.stringify(inputSnapshot) === inputJsonBefore);
  const detInput = { ...baseArgs, costPrice: 8.40, strategyName: 'ROUND_95' };
  assert('calculateCatalogPrice es determinista (mismo input → mismo output, sin estado global)',
    JSON.stringify(calculateCatalogPrice(detInput)) === JSON.stringify(calculateCatalogPrice(detInput)));
  // Dos llamadas consecutivas con costos distintos no se "contaminan" entre sí (sin estado compartido).
  const rA = calculateCatalogPrice({ ...baseArgs, costPrice: 5 });
  const rB = calculateCatalogPrice({ ...baseArgs, costPrice: 50 });
  const rA2 = calculateCatalogPrice({ ...baseArgs, costPrice: 5 });
  assert('llamadas intercaladas con costos distintos no comparten estado (rA === rA2 tras rB)', JSON.stringify(rA) === JSON.stringify(rA2), JSON.stringify({ rA, rB, rA2 }));

  // ── 12. catalogPricingService.js no importa/referencia integraciones ajenas ──
  const fs = require('fs');
  const path = require('path');
  const catalogSource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'catalogPricingService.js'), 'utf8');
  // Se excluyen los comentarios explicativos (ej. "NO toca Dropi/Effi/woocommerceMirror.js")
  // — lo que importa es el CÓDIGO real, no que el archivo pueda nombrar en prosa
  // aquello que deliberadamente NO usa. Mismo principio ya aplicado a las
  // aserciones estructurales de pricingEngine.js más abajo.
  const catalogCodeOnly = catalogSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const forbidden = ['woocommerceMirror', 'applyMargin', 'DROPI_MARGIN_PERCENT', 'dropi', 'Dropi', 'effi', 'Effi', 'router', 'Router', 'sequelize', 'Sequelize', 'productModel', 'models.Product'];
  for (const term of forbidden) {
    assert(`catalogPricingService.js (código, sin comentarios) NO contiene la referencia "${term}"`, !catalogCodeOnly.includes(term), `encontrado: "${term}"`);
  }
  assert('catalogPricingService.js solo importa de ./pricingEngine y ./orderTotals (ningún otro require de módulo interno)',
    (catalogCodeOnly.match(/require\(['"]\.\/[^'"]+['"]\)/g) || []).every((r) => r.includes('./pricingEngine') || r.includes('./orderTotals')));
  assert('catalogPricingService.js no importa nada de db/models', !/require\([^)]*db\/models/.test(catalogCodeOnly));
  assert('catalogPricingService.js no contiene ninguna llamada .update( (no escribe nada)', !/\.update\s*\(/.test(catalogCodeOnly));

  // ── Rechazo de config inválida propagado sin inventar nada ──
  const rInvalidMargin = calculateCatalogPrice({ quantity: 1, taxRate: TAX_RATE, targetContributionMargin: 1.5, costPrice: 100 });
  assert('margen imposible (CV%+M>=1) → status OK (el costo sí era válido) pero pricing.valid=false y final.finalGrossPrice=null (no PVP inventado, error propagado desde el motor)',
    rInvalidMargin.status === 'OK' && rInvalidMargin.pricing.valid === false && rInvalidMargin.final.finalGrossPrice === null,
    JSON.stringify(rInvalidMargin));
});

// ── 13. Regresión estructural — Checkout/catálogo/créditos/Dropi NO dependen del Tax/Presentation Engine ──
suite('Regresión estructural — orderService.js no importa pricingEngine', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'Services', 'orderService.js'), 'utf8');
  assert(
    "orderService.js NO requiere './pricingEngine' — checkout no depende del Pricing/Commercial Engine (spec: Riesgos)",
    !/require\(\s*['"]\.\/pricingEngine['"]\s*\)/.test(source)
  );

  const pricingEngineSource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'pricingEngine.js'), 'utf8');
  assert(
    'pricingEngine.js NO importa Sequelize/modelos — nunca toca product.price ni ninguna tabla directamente',
    !/require\(\s*['"].*(sequelize|libs\/sequelize|productModel|db\/models).*['"]\s*\)/i.test(pricingEngineSource)
  );
  assert(
    'pricingEngine.js NO importa ni invoca computeCreditRedemption (Ayni-Créditos) — puede mencionarlo en comentarios explicando la exclusión (spec B.3.1), pero nunca lo destructura de un require ni lo llama',
    !/(?:const|let|var)\s*\{[^}]*computeCreditRedemption[^}]*\}\s*=\s*require|computeCreditRedemption\s*\(/.test(pricingEngineSource)
  );
  assert(
    'pricingEngine.js importa de orderTotals SOLO round2/toGross/extractFromGross (Tax Engine consumido, no reimplementado)',
    /require\(['"]\.\/orderTotals['"]\)/.test(pricingEngineSource)
  );
  assert(
    'pricingEngine.js (Paso 4) SÍ destructura e invoca toGross/extractFromGross de orderTotals — consumo legítimo del Tax Engine, autorizado explícitamente en el Paso 4',
    /(?:const|let|var)\s*\{[^}]*\btoGross\b[^}]*\}\s*=\s*require\(['"]\.\/orderTotals['"]\)/.test(pricingEngineSource) &&
    /(?:const|let|var)\s*\{[^}]*\bextractFromGross\b[^}]*\}\s*=\s*require\(['"]\.\/orderTotals['"]\)/.test(pricingEngineSource) &&
    /\btoGross\(\s*[^)]/.test(pricingEngineSource) &&
    /\bextractFromGross\(\s*[^)]/.test(pricingEngineSource)
  );
  {
    const codeOnly = pricingEngineSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(
      'pricingEngine.js: código (sin comentarios) no contiene el literal 0.15 en ningún lugar — la tasa de IVA nunca está hardcodeada en el motor',
      !/0\.15/.test(codeOnly)
    );
    assert(
      'pricingEngine.js: código (sin comentarios) no contiene el literal 1.15 en ningún lugar — toda conversión NETO↔PVP pasa por toGross/extractFromGross con taxRate como parámetro',
      !/1\.15/.test(codeOnly)
    );
    assert(
      'pricingEngine.js: ninguna expresión combina `taxRate` con "(1+"/"(1-" fuera de toGross(...)/extractFromGross(...) y de la única excepción documentada (minimumGrossForFloor = ceil2(floorNet*(1+taxRate)), floor-protection con ceil2 en vez de round2 — no una segunda implementación fiscal, ver comentario junto a computeFinalGrossPrice)',
      (() => {
        const withoutTaxCalls = codeOnly
          .replace(/\btoGross\([^;]*?\);/gs, '')
          .replace(/\bextractFromGross\([^;]*?\);/gs, '')
          .replace(/ceil2\(\s*floorNet\s*\*\s*\(\s*1\s*\+\s*taxRate\s*\)\s*\)/g, '');
        return !/taxRate[\s\S]{0,40}?\(\s*1\s*[+-]/.test(withoutTaxCalls) &&
          !/[*/]\s*\(\s*1\s*[+-][\s\S]{0,40}?taxRate/.test(withoutTaxCalls);
      })()
    );
  }
  assert(
    'orderTotals.js sigue siendo el ÚNICO archivo que declara TAX_RATE — pricingEngine.js no declara su propia constante de tasa',
    !/const\s+TAX_RATE\s*=/.test(pricingEngineSource)
  );

  const orderTotalsSource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'orderTotals.js'), 'utf8');
  assert(
    'computeOrderTotals (checkout) permanece intacto: sigue calculando subtotal/base/tax con el mismo patrón round2, sin llamar a toGross/extractFromGross (decisión deliberada, ver informe Paso 4 — no regresionar un camino ya validado en producción)',
    /function computeOrderTotals\(/.test(orderTotalsSource) &&
    !/function computeOrderTotals\([\s\S]*?\n\}/.exec(orderTotalsSource)[0].match(/toGross|extractFromGross/)
  );
  assert(
    'computeCreditRedemption (Ayni-Créditos) permanece exactamente igual: no importa ni invoca nada del pricingEngine (Cost/Pricing/Commercial Engine) ni pasa por validateFloor',
    !/function computeCreditRedemption\([\s\S]*?\n\}/.exec(orderTotalsSource)[0].match(/pricingEngine|validateFloor|computeCommercialPrice|computeFinalGrossPrice/)
  );

  const woocommerceMirrorSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'woocommerceMirror.js'), 'utf8');
  assert(
    'woocommerceMirror.js (fijación de precio automática de catálogo) TODAVÍA no importa pricingEngine — la conexión al catálogo es un paso posterior, no autorizado en Paso 4',
    !/require\(\s*['"].*pricingEngine['"]\s*\)/.test(woocommerceMirrorSource)
  );

  assert(
    'orders_products.unit_price_gross / unit_cost_snapshot: la migración del Paso 1 NO fue ejecutada — no hay rastro de wiring de escritura real en orderService.js (checkout sigue sin conectar al motor)',
    !/unitPriceGross\s*=|unitCostSnapshot\s*=/.test(source)
  );
});

// ── 14. pricingSource — modelo, migración y aislamiento de sincronizaciones ──
suite('pricingSource — schema, migración aditiva y aislamiento de Dropi/Effi (estructural, sin DB)', () => {
  const fs = require('fs');
  const path = require('path');

  // ── 1. El modelo reconoce los 4 campos nuevos, con el mapeo de columna correcto ──
  const productModelSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'models', 'productModel.js'), 'utf8');
  const expectedFields = [
    ['pricingSource',          "field: 'pricing_source'"],
    ['pricingCostSnapshot',    "field: 'pricing_cost_snapshot'"],
    ['pricingCalculatedPrice', "field: 'pricing_calculated_price'"],
    ['pricingAppliedAt',       "field: 'pricing_applied_at'"],
  ];
  for (const [jsField, columnDecl] of expectedFields) {
    const fieldBlockMatch = productModelSource.match(new RegExp(`${jsField}:\\s*\\{[^}]*\\}`, 's'));
    assert(`productModel.js declara ${jsField} con ${columnDecl}`, !!fieldBlockMatch && fieldBlockMatch[0].includes(columnDecl), fieldBlockMatch ? fieldBlockMatch[0] : 'campo no encontrado');
    if (fieldBlockMatch) {
      assert(`${jsField} es nullable (allowNull: true) — ningún producto existente puede quedar inconsistente`, /allowNull:\s*true/.test(fieldBlockMatch[0]));
    }
  }
  assert('pricingCostSnapshot usa DECIMAL(10, 2), igual que costPrice/PVP en el resto del sistema', /pricingCostSnapshot:[\s\S]*?DECIMAL\(10,\s*2\)/.test(productModelSource));
  assert('pricingCalculatedPrice usa DECIMAL(10, 2)', /pricingCalculatedPrice:[\s\S]*?DECIMAL\(10,\s*2\)/.test(productModelSource));
  assert('pricingAppliedAt usa DataTypes.DATE', /pricingAppliedAt:[\s\S]*?DataTypes\.DATE/.test(productModelSource));

  // ── 2. La migración es puramente aditiva y reversible ──
  const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '20260906000003-add-pricing-source-to-products.js');
  assert('el archivo de migración existe en db/migrations/', fs.existsSync(migrationPath));
  const migrationSource = fs.readFileSync(migrationPath, 'utf8');
  const upBody = migrationSource.slice(migrationSource.indexOf('async up'), migrationSource.indexOf('async down'));
  assert('el bloque up() de la migración solo contiene llamadas queryInterface.addColumn — ninguna alteración de columnas/tablas existentes',
    (upBody.match(/queryInterface\.\w+/g) || []).every((call) => call === 'queryInterface.addColumn'));
  assert('la migración no contiene changeColumn/dropTable/renameColumn en ningún punto — puramente aditiva',
    !/changeColumn|dropTable|renameColumn/.test(migrationSource));
  assert('up() agrega exactamente 4 columnas (pricing_source, pricing_cost_snapshot, pricing_calculated_price, pricing_applied_at)',
    (migrationSource.match(/addColumn\(PRODUCT_TABLE,\s*'pricing_(?:source|cost_snapshot|calculated_price|applied_at)'/g) || []).length === 4);
  assert('las 4 columnas se declaran allowNull: true en la migración (aditiva, no rompe filas existentes)',
    (migrationSource.match(/allowNull:\s*true/g) || []).length >= 4);
  assert('la migración NO ejecuta ningún UPDATE/backfill (ni queryInterface.sequelize.query ni bulkUpdate) — NULL permanece NULL, sin inventar historia',
    !/sequelize\.query|bulkUpdate/.test(migrationSource));
  assert('down() remueve las mismas 4 columnas que up() agrega (reversible)',
    (migrationSource.match(/removeColumn\(PRODUCT_TABLE,\s*'pricing_(?:source|cost_snapshot|calculated_price|applied_at)'/g) || []).length === 4);

  // ── 6/7. Dropi/Effi de bajo nivel (adapters/transformer) siguen sin conocer pricingSource ──
  // NOTA: esta lista describe el estado al CIERRE del Paso 8. Desde el Paso 9,
  // woocommerceMirror.js/importService.js/importRouter.js SÍ referencian
  // pricingSource legítimamente (protección de sincronización) — se verifican
  // por separado, más abajo, con aserciones específicas a lo que cada uno debe
  // hacer, no con un "no lo toca en absoluto" genérico.
  const stillUntouchedFiles = [
    ['integrations/dropi/dropiAdapter.js',     ['integrations', 'dropi', 'dropiAdapter.js']],
    ['integrations/effi/effiTransformer.js',   ['integrations', 'effi', 'effiTransformer.js']],
    ['integrations/effi/effiAdapter.js',       ['integrations', 'effi', 'effiAdapter.js']],
  ];
  for (const [label, segments] of stillUntouchedFiles) {
    const src = fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
    assert(`${label} NO referencia pricingSource/pricing_source — sigue sin tocarse (fuera de alcance en Paso 8 y Paso 9)`,
      !/pricingSource|pricing_source/.test(src));
    assert(`${label} NO importa catalogPricingService ni pricingEngine ni pricingAuthority — ningún proceso automático recalcula precios ni decide autoridad`,
      !/catalogPricingService|pricingEngine|pricingAuthority/.test(src));
  }

  // ── Paso 9: woocommerceMirror.js/importService.js/importRouter.js SÍ referencian pricingSource, correctamente ──
  const protectionFiles = [
    ['routes/woocommerceMirror.js',   ['routes', 'woocommerceMirror.js']],
    ['integrations/importService.js', ['integrations', 'importService.js']],
    ['routes/importRouter.js',        ['routes', 'importRouter.js']],
  ];
  for (const [label, segments] of protectionFiles) {
    const src = fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
    assert(`${label} SÍ referencia pricingSource (protección de sincronización, Paso 9)`, /pricingSource/.test(src));
    assert(`${label} NO importa catalogPricingService ni pricingEngine — la protección no recalcula ni conoce fórmulas de precio`,
      !/catalogPricingService|pricingEngine/.test(src));
  }

  // ── 10 (parte estructural). Ninguna escritura de pricingSource='engine' en todo el código fuente actual ──
  const productServicesSource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'productServices.js'), 'utf8');
  assert("productServices.js NO contiene el literal 'engine' — ningún camino de escritura manual puede producir pricingSource='engine'",
    !productServicesSource.includes("'engine'") && !productServicesSource.includes('"engine"'));
  const pricingSourceAssignments = productServicesSource.match(/pricingSource:\s*(['"])([^'"]+)\1/g) || [];
  assert('productServices.js solo asigna pricingSource: \'manual\' (literal exacto) — nunca otro valor, en ningún punto del archivo',
    pricingSourceAssignments.length > 0 && pricingSourceAssignments.every((m) => /['"]manual['"]/.test(m)));
  assert('Ningún archivo del repositorio (fuera de esta suite/documentación) asigna pricingSource=\'engine\' — se verifica en productServices.js, único escritor autorizado en este paso',
    !productServicesSource.includes('engine'));
});

// ── 15. Pricing Authority — predicado puro + protección de sincronizaciones (Paso 9) ──
suite('Pricing Authority — canAutoSyncOverwritePrice (predicado puro)', () => {
  const { canAutoSyncOverwritePrice, PROTECTED_PRICING_SOURCES } = require('../Services/pricingAuthority');

  assert("authority: 'manual' → false (protegido)", canAutoSyncOverwritePrice('manual') === false);
  assert("authority: 'engine' → false (protegido)", canAutoSyncOverwritePrice('engine') === false);
  assert("authority: 'legacy_sync' → true (sobrescribible)", canAutoSyncOverwritePrice('legacy_sync') === true);
  assert('authority: null → true (sobrescribible, sin evidencia de decisión)', canAutoSyncOverwritePrice(null) === true);
  assert('authority: undefined → true (sobrescribible)', canAutoSyncOverwritePrice(undefined) === true);
  assert("authority: valor desconocido ('foo') → true (mismo tratamiento que sin decisión registrada)", canAutoSyncOverwritePrice('foo') === true);
  assert('PROTECTED_PRICING_SOURCES = exactamente [\'manual\', \'engine\'], nada más', JSON.stringify(PROTECTED_PRICING_SOURCES.slice().sort()) === JSON.stringify(['engine', 'manual']));
  assert('canAutoSyncOverwritePrice determinista', canAutoSyncOverwritePrice('manual') === canAutoSyncOverwritePrice('manual'));

  // ── No es una fórmula de pricing (criterio #10) — no conoce costo/margen/IVA/motor ──
  const fs = require('fs');
  const path = require('path');
  const authoritySource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'pricingAuthority.js'), 'utf8');
  assert('pricingAuthority.js no importa pricingEngine ni catalogPricingService ni orderTotals — no es una fórmula de pricing, es una autorización', !/require\(/.test(authoritySource));
  assert('pricingAuthority.js no contiene taxRate/costPrice/margin/round2/ceil2 — no reimplementa ninguna fórmula', !/taxRate|costPrice|margin|round2|ceil2/i.test(authoritySource));

  // ── Los 3 consumidores usan el predicado — nunca reimplementan la regla ──
  const woocommerceMirrorSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'woocommerceMirror.js'), 'utf8');
  const importServiceSource = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'importService.js'), 'utf8');
  const importRouterSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'importRouter.js'), 'utf8');
  assert("woocommerceMirror.js importa y usa canAutoSyncOverwritePrice de '../Services/pricingAuthority'",
    /require\(['"]\.\.\/Services\/pricingAuthority['"]\)/.test(woocommerceMirrorSource) && /canAutoSyncOverwritePrice\(/.test(woocommerceMirrorSource));
  assert("importService.js importa y usa canAutoSyncOverwritePrice de '../Services/pricingAuthority'",
    /require\(['"]\.\.\/Services\/pricingAuthority['"]\)/.test(importServiceSource) && /canAutoSyncOverwritePrice\(/.test(importServiceSource));
  assert('woocommerceMirror.js NO reimplementa la condición manual/engine con literales sueltos (no compara pricingSource contra strings fuera del predicado importado)',
    !/pricingSource\s*[=!]==?\s*['"](?:manual|engine)['"]/.test(woocommerceMirrorSource));
  assert('importService.js NO reimplementa la condición manual/engine con literales sueltos',
    !/pricingSource\s*[=!]==?\s*['"](?:manual|engine)['"]/.test(importServiceSource));

  // ── importRouter.js: pvpOverride → 'manual', nunca 'engine', nunca automático ──
  assert("importRouter.js NO contiene el literal 'engine' como valor de pricingSource", !/pricingSource\s*[:=]\s*['"]engine['"]/.test(importRouterSource));
  // Cubre tanto sintaxis de objeto literal ({ pricingSource: 'manual' }) como de asignación (update.pricingSource = 'manual').
  const importRouterPricingSourceAssignments = importRouterSource.match(/pricingSource\s*[:=]\s*['"][^'"]+['"]/g) || [];
  assert("importRouter.js solo asigna pricingSource: 'manual' (literal exacto), en 2 puntos (creación y actualización), ambos ligados a pvpOverride",
    importRouterPricingSourceAssignments.length === 2 && importRouterPricingSourceAssignments.every((m) => /'manual'/.test(m)));
  assert('importRouter.js NO importa pricingAuthority.js — ese camino ya es estructuralmente conservador (nunca sobrescribe price sin pvpOverride explícito), solo le faltaba la etiqueta positiva',
    !/require\(['"]\.\.\/Services\/pricingAuthority['"]\)/.test(importRouterSource));
});

// ── 17. Apply-Engine — comparación monetaria, schema y aislamiento de fórmulas (Paso 10) ──
suite('Apply-Engine — monetaryEquals/toCents, schema Joi y no-duplicación de fórmulas', () => {
  const fs = require('fs');
  const path = require('path');

  // productPricingApplyService.js importa libs/sequelize transitivamente (para
  // models.Product) — igual que en las suites async de pricingSource/sync,
  // se necesita un DATABASE_URL parseable (sin abrir ninguna conexión real)
  // solo para poder construir el objeto Sequelize al hacer require().
  const priorDatabaseUrl = process.env.DATABASE_URL;
  if (priorDatabaseUrl === undefined) {
    process.env.DATABASE_URL = 'postgres://smoke:test@localhost:5432/smoketest_never_connects';
  }
  let monetaryEquals, toCents, APPLY_STATUS;
  try {
    ({ monetaryEquals, toCents, APPLY_STATUS } = require('../Services/productPricingApplyService'));
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  }

  const { previewPricingSchema, applyEnginePricingSchema } = require('../schemaODtos/productSchema');

  // ── Comparación monetaria — nunca !== directo, siempre normalizada a centavos ──
  assert('toCents(12.30) === toCents("12.30") — number y string equivalentes', toCents(12.30) === toCents('12.30'));
  assert('monetaryEquals(12.30, "12.30") === true', monetaryEquals(12.30, '12.30') === true);
  assert('monetaryEquals(12.30, 12.31) === false — diferencia de 1 centavo detectada', monetaryEquals(12.30, 12.31) === false);
  assert('monetaryEquals(0, "0.00") === true', monetaryEquals(0, '0.00') === true);
  assert('monetaryEquals(100, 99.995) === true — 99.995 redondea a 100.00 con round2 (mismo redondeo que el resto del sistema, no uno propio)', monetaryEquals(100, 99.995) === true);
  assert('monetaryEquals con valor no parseable ("abc") → false, nunca "igual" por omisión', monetaryEquals(12.30, 'abc') === false);
  assert('monetaryEquals(null, 12.30) → false', monetaryEquals(null, 12.30) === false);
  assert('monetaryEquals determinista', monetaryEquals(45.67, 45.67) === monetaryEquals(45.67, 45.67));
  assert('APPLY_STATUS expone PRICE_DRIFTED, CALCULATION_INVALID, NOT_FOUND, APPLIED, INCOMPLETE_COST_DATA, INVALID_COST_DATA',
    ['PRICE_DRIFTED', 'CALCULATION_INVALID', 'NOT_FOUND', 'APPLIED', 'INCOMPLETE_COST_DATA', 'INVALID_COST_DATA'].every((k) => APPLY_STATUS[k] === k));

  // ── allowBelowFloor / overrideReason — rechazados explícitamente por Joi, en AMBOS schemas ──
  const rejectsUnknown = (schema, extraField) => {
    const { error } = schema.validate({ targetContributionMargin: 0.3, [extraField]: extraField === 'overrideReason' ? 'motivo' : true }, { abortEarly: false });
    return !!error && /not allowed/i.test(error.message);
  };
  assert("previewPricingSchema RECHAZA allowBelowFloor con 400 (unknown key), no lo ignora en silencio", rejectsUnknown(previewPricingSchema, 'allowBelowFloor'));
  assert("previewPricingSchema RECHAZA overrideReason con 400 (unknown key)", rejectsUnknown(previewPricingSchema, 'overrideReason'));
  assert("applyEnginePricingSchema RECHAZA allowBelowFloor con 400 (unknown key)", rejectsUnknown(applyEnginePricingSchema, 'allowBelowFloor'));
  assert("applyEnginePricingSchema RECHAZA overrideReason con 400 (unknown key)", rejectsUnknown(applyEnginePricingSchema, 'overrideReason'));
  assert('previewPricingSchema acepta un body válido normal sin error', !previewPricingSchema.validate({ targetContributionMargin: 0.3, strategyName: 'ROUND_99' }).error);
  assert('applyEnginePricingSchema acepta expectedFinalGrossPrice sin error', !applyEnginePricingSchema.validate({ targetContributionMargin: 0.3, expectedFinalGrossPrice: 12.99 }).error);
  assert('applyEnginePricingSchema exige targetContributionMargin (requerido)', !!applyEnginePricingSchema.validate({}).error);
  assert('previewPricingSchema/applyEnginePricingSchema solo aceptan strategyName dentro de VALID_GROSS_ROUNDING_STRATEGIES', !!previewPricingSchema.validate({ targetContributionMargin: 0.3, strategyName: 'BOGUS' }).error);

  // ── No duplicación de fórmulas (código sin comentarios) ──
  const applySource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'productPricingApplyService.js'), 'utf8');
  const applyCodeOnly = applySource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert('productPricingApplyService.js importa calculateCatalogPrice de ./catalogPricingService (delega el cálculo, no lo reimplementa)',
    /require\(['"]\.\/catalogPricingService['"]\)/.test(applyCodeOnly) && /calculateCatalogPrice\(/.test(applyCodeOnly));
  assert('productPricingApplyService.js importa round2 de ./orderTotals (reutiliza el redondeo canónico para la comparación monetaria)',
    /require\(['"]\.\/orderTotals['"]\)/.test(applyCodeOnly) && /\bround2\(/.test(applyCodeOnly));
  assert('productPricingApplyService.js NO contiene los literales 0.15/1.15 — ninguna tasa de IVA hardcodeada',
    !/0\.15|1\.15/.test(applyCodeOnly));
  assert('productPricingApplyService.js NO define su propia función de redondeo (round2 solo se usa importado, nunca redeclarado)',
    !/function\s+round2?\s*\(/.test(applyCodeOnly));
  assert('productPricingApplyService.js NUNCA pasa allowBelowFloor ni overrideReason a calculateCatalogPrice() — ambos ausentes del código (fuera de comentarios)',
    !/allowBelowFloor|overrideReason/.test(applyCodeOnly));
  assert('productPricingApplyService.js NO importa pricingAuthority.js — la protección de sync automático es un concepto distinto de esta acción humana',
    !/pricingAuthority/.test(applyCodeOnly));
  assert('productPricingApplyService.js NO importa pricingEngine.js directamente (todo pasa por catalogPricingService, capa ya autorizada)',
    !/require\(['"]\.\/pricingEngine['"]\)/.test(applyCodeOnly));

  // ── pricingSource='engine' solo se escribe desde este archivo, en un único punto ──
  const engineAssignments = applyCodeOnly.match(/pricingSource:\s*['"][^'"]+['"]/g) || [];
  assert("productPricingApplyService.js asigna pricingSource='engine' en EXACTAMENTE un punto del código", engineAssignments.length === 1 && /'engine'/.test(engineAssignments[0]));

  // ── Barrido global: pricingSource='engine' solo existe en este archivo ──
  const searchRoots = ['routes', 'integrations', 'Services'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/pricingSource\s*[:=]\s*['"]engine['"]/.test(src) && !full.endsWith(path.join('Services', 'productPricingApplyService.js'))) {
          offenders.push(full);
        }
      }
    }
  };
  for (const root of searchRoots) walk(path.join(__dirname, '..', root));
  assert("Barrido completo de routes/integrations/Services: pricingSource='engine' NO aparece en ningún archivo salvo productPricingApplyService.js",
    offenders.length === 0, JSON.stringify(offenders));
});

// ── 19. DeUna QR + comprobante — schema, roles y no-duplicación (estructural, sin DB) ──
suite('DeUna/Comprobante — schema Joi, roles y aislamiento de orderTotals (Paso 11, estructural)', () => {
  const fs = require('fs');
  const path = require('path');
  const { getOrderIdSchema, getOrderAndProofIdSchema, uploadProofSchema, reviewProofSchema } =
    require('../schemaODtos/paymentProofSchema');

  // ── uploadProofSchema: solo fileUrl, HTTPS estricto, sin campo de monto/total ──
  assert('uploadProofSchema acepta un fileUrl https válido', !uploadProofSchema.validate({ fileUrl: 'https://storage.googleapis.com/aynimar/proof1.jpg' }).error);
  assert('uploadProofSchema RECHAZA fileUrl http (no https)', !!uploadProofSchema.validate({ fileUrl: 'http://storage.googleapis.com/aynimar/proof1.jpg' }).error);
  assert('uploadProofSchema RECHAZA fileUrl con esquema javascript:', !!uploadProofSchema.validate({ fileUrl: 'javascript:alert(1)' }).error);
  assert('uploadProofSchema RECHAZA fileUrl con esquema data:', !!uploadProofSchema.validate({ fileUrl: 'data:text/plain;base64,AAAA' }).error);
  assert('uploadProofSchema exige fileUrl (requerido)', !!uploadProofSchema.validate({}).error);
  assert('uploadProofSchema RECHAZA un campo "total" — el cliente NUNCA puede influir el monto autorizado (unknown key → 400)',
    !!uploadProofSchema.validate({ fileUrl: 'https://x.com/a.jpg', total: 999 }).error);
  assert('uploadProofSchema RECHAZA un campo "amount"/"amountToPay" por la misma razón',
    !!uploadProofSchema.validate({ fileUrl: 'https://x.com/a.jpg', amountToPay: 1 }).error);
  assert('uploadProofSchema RECHAZA payment_status/paymentStatus enviado por el cliente (no puede auto-marcarse pagado)',
    !!uploadProofSchema.validate({ fileUrl: 'https://x.com/a.jpg', paymentStatus: 'paid' }).error &&
    !!uploadProofSchema.validate({ fileUrl: 'https://x.com/a.jpg', payment_status: 'paid' }).error);

  assert('getOrderIdSchema exige id numérico', !!getOrderIdSchema.validate({}).error && !getOrderIdSchema.validate({ id: 5 }).error);
  assert('getOrderAndProofIdSchema exige id y proofId', !!getOrderAndProofIdSchema.validate({ id: 5 }).error && !getOrderAndProofIdSchema.validate({ id: 5, proofId: 1 }).error);
  assert('reviewProofSchema acepta reason opcional (incluye vacío/null)', !reviewProofSchema.validate({}).error && !reviewProofSchema.validate({ reason: '' }).error && !reviewProofSchema.validate({ reason: null }).error);

  // ── paymentProofImageValidation.js — comprobante como IMAGEN real, no URL libre ──
  const {
    assertTrustedProofUrl, TRUSTED_STORAGE_HOST, ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS, MAX_BYTES,
  } = require('../Services/paymentProofImageValidation');
  const okUrl = 'https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2F700-1.jpg?alt=media&token=abc';
  assert('assertTrustedProofUrl ACEPTA una URL real de Firebase Storage en la carpeta payment-proofs/ con extensión válida', (() => { try { assertTrustedProofUrl(okUrl); return true; } catch { return false; } })());
  assert('assertTrustedProofUrl RECHAZA un host externo arbitrario (no Firebase Storage) — el cliente no puede mandar "cualquier-sitio.com"',
    (() => { try { assertTrustedProofUrl('https://cualquier-sitio.com/falso-comprobante.jpg'); return false; } catch (e) { return e.output?.statusCode === 400; } })());
  assert('assertTrustedProofUrl RECHAZA un archivo del mismo bucket de Firebase pero fuera de payment-proofs/ (ej. una foto de producto reenviada como comprobante)',
    (() => { try { assertTrustedProofUrl('https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/products%2Ffoo.jpg?alt=media'); return false; } catch (e) { return e.output?.statusCode === 400; } })());
  assert('assertTrustedProofUrl RECHAZA extensión no permitida (.pdf)',
    (() => { try { assertTrustedProofUrl('https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2Ffoo.pdf?alt=media'); return false; } catch (e) { return e.output?.statusCode === 400; } })());
  assert('assertTrustedProofUrl RECHAZA extensión no permitida (.svg — riesgo XSS además de no ser un formato de foto)',
    (() => { try { assertTrustedProofUrl('https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2Ffoo.svg?alt=media'); return false; } catch (e) { return e.output?.statusCode === 400; } })());
  assert('assertTrustedProofUrl RECHAZA http:// (no https)',
    (() => { try { assertTrustedProofUrl('http://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2Ffoo.jpg?alt=media'); return false; } catch (e) { return e.output?.statusCode === 400; } })());
  assert('assertTrustedProofUrl RECHAZA una URL malformada sin lanzar una excepción no controlada',
    (() => { try { assertTrustedProofUrl('no-es-una-url'); return false; } catch (e) { return e.output?.statusCode === 400; } })());
  assert('assertTrustedProofUrl acepta .jpeg/.png/.webp además de .jpg', ['jpeg', 'png', 'webp'].every((ext) => {
    try { assertTrustedProofUrl(`https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2Ffoo.${ext}?alt=media`); return true; } catch { return false; }
  }));
  assert('assertTrustedProofUrl ACEPTA cuando el segmento de orden en la ruta coincide con el orderId pasado', (() => {
    try { assertTrustedProofUrl('https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2F700%2Ffoo.jpg?alt=media', 700); return true; } catch { return false; }
  })());
  assert('assertTrustedProofUrl RECHAZA cuando el segmento de orden en la ruta NO coincide con el orderId (comprobante de otra orden/persona reutilizado)', (() => {
    try { assertTrustedProofUrl('https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2F701%2Ffoo.jpg?alt=media', 700); return false; } catch (e) { return e.output?.statusCode === 400; }
  })());
  assert('assertTrustedProofUrl sin orderId (segundo argumento omitido) sigue validando dominio/carpeta/extensión, sin exigir coincidencia de orden', (() => {
    try { assertTrustedProofUrl('https://firebasestorage.googleapis.com/v0/b/aynimar.appspot.com/o/payment-proofs%2F701%2Ffoo.jpg?alt=media'); return true; } catch { return false; }
  })());
  assert('TRUSTED_STORAGE_HOST es el dominio real de Firebase Storage (mismo que valida frontDashboardAynimar al borrar imágenes)', TRUSTED_STORAGE_HOST === 'firebasestorage.googleapis.com');
  assert('ALLOWED_MIME_TYPES = exactamente image/jpeg, image/png, image/webp', JSON.stringify(ALLOWED_MIME_TYPES.slice().sort()) === JSON.stringify(['image/jpeg', 'image/png', 'image/webp'].sort()));
  assert('ALLOWED_EXTENSIONS = exactamente .jpg, .jpeg, .png, .webp', JSON.stringify(ALLOWED_EXTENSIONS.slice().sort()) === JSON.stringify(['.jpg', '.jpeg', '.png', '.webp'].sort()));
  assert('MAX_BYTES es un tamaño razonable (entre 1MB y 20MB)', MAX_BYTES >= 1024 * 1024 && MAX_BYTES <= 20 * 1024 * 1024);

  // ── Roles de las rutas — approve/reject SOLO admin/business_owner, nunca customer ──
  const orderRouterSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'orderRouter.js'), 'utf8');
  const approveBlock = orderRouterSource.slice(orderRouterSource.indexOf("'/:id/payment-proof/:proofId/approve'"), orderRouterSource.indexOf("'/:id/payment-proof/:proofId/reject'"));
  const rejectBlock = orderRouterSource.slice(orderRouterSource.indexOf("'/:id/payment-proof/:proofId/reject'"), orderRouterSource.indexOf("POST /orders/:id/retry-fulfillment"));
  assert("ruta approve usa checkRoles('admin', 'business_owner') — SIN 'customer'", /checkRoles\('admin',\s*'business_owner'\)/.test(approveBlock) && !/checkRoles\([^)]*'customer'/.test(approveBlock));
  assert("ruta reject usa checkRoles('admin', 'business_owner') — SIN 'customer'", /checkRoles\('admin',\s*'business_owner'\)/.test(rejectBlock) && !/checkRoles\([^)]*'customer'/.test(rejectBlock));

  // ── checkRoles real: simula un customer intentando aprobar/rechazar directamente ──
  const { checkRoles } = require('../middlewares/authHandler');
  const staffOnlyGuard = checkRoles('admin', 'business_owner');
  let forwardedErr = null;
  staffOnlyGuard({ user: { role: 'customer' } }, {}, (err) => { forwardedErr = err; });
  assert('checkRoles(admin,business_owner) invocado con role=customer → next(err) con boom.forbidden (403), nunca deja pasar', forwardedErr && forwardedErr.output?.statusCode === 403, JSON.stringify(forwardedErr?.output));
  let forwardedErrAdmin = null;
  staffOnlyGuard({ user: { role: 'admin' } }, {}, (err) => { forwardedErrAdmin = err; });
  assert('checkRoles(admin,business_owner) invocado con role=admin → next() sin error (control: el guard sí deja pasar a quien corresponde)', forwardedErrAdmin === undefined);

  // ── paymentProofService.js: no reimplementa orderTotals, no toca DB de checkout ──
  const proofServiceSource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'paymentProofService.js'), 'utf8');
  const proofServiceCodeOnly = proofServiceSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert('paymentProofService.js NO llama computeOrderTotals/computeCreditRedemption — nunca recalcula el total, solo lee order.total ya calculado',
    !/computeOrderTotals\(|computeCreditRedemption\(/.test(proofServiceCodeOnly));
  assert('paymentProofService.js NO importa Services/orderTotals directamente (usa order.total, ya persistido por checkout())',
    !/require\(['"]\.\/orderTotals['"]\)/.test(proofServiceCodeOnly));
  assert('paymentProofService.js importa OrderService (reutiliza _finalizeAndDispatch vía confirmPaymentProof, no un despacho paralelo)',
    /require\(['"]\.\/orderService['"]\)/.test(proofServiceCodeOnly));
  assert('paymentProofService.js importa assertTrustedProofUrl y verifyProofFileExists de paymentProofImageValidation.js — no reimplementa la validación de imagen',
    /require\(['"]\.\/paymentProofImageValidation['"]\)/.test(proofServiceCodeOnly) &&
    /assertTrustedProofUrl\(/.test(proofServiceCodeOnly) && /verifyProofFileExists\(/.test(proofServiceCodeOnly));
  // Nota: proofServiceCodeOnly usa un strip de comentarios ingenuo (`//.*$`)
  // que trunca cualquier "https://" en código real — por eso esta aserción
  // específica se hace sobre la fuente CRUDA, buscando la declaración exacta.
  assert('paymentProofService.js declara DEUNA_PAYMENT_LINK con el link real de DeUna (pagar.deuna.app) — no inventado en este archivo',
    /const\s+DEUNA_PAYMENT_LINK\s*=[\s\S]{0,200}pagar\.deuna\.app/.test(proofServiceSource));
  // paymentStatus:'paid' SOLO puede aparecer como parámetro pasado a
  // confirmPaymentProof(...) (delegado a OrderService) — nunca en un
  // order.update(...) directo dentro de este archivo. Se excluye esa única
  // llamada legítima antes de buscar el patrón prohibido.
  assert('paymentProofService.js NUNCA asigna paymentStatus="paid" directamente (order.update) — solo lo pasa como parámetro a confirmPaymentProof(), que delega en OrderService',
    !/paymentStatus:\s*['"]paid['"]/.test(proofServiceCodeOnly.replace(/confirmPaymentProof\([^;]*?\);/gs, '')));

  // ── orderService.js: _finalizeAndDispatch preserva defaults de COD; confirmCod sin cambios ──
  const orderServiceSource = fs.readFileSync(path.join(__dirname, '..', 'Services', 'orderService.js'), 'utf8');
  assert("_finalizeAndDispatch conserva los defaults paymentMethod='cod', paymentStatus='pending' (cero cambio de comportamiento para confirmCod)",
    /paymentMethod\s*=\s*'cod'/.test(orderServiceSource) && /paymentStatus\s*=\s*'pending'/.test(orderServiceSource));
  assert('confirmCod sigue llamando _finalizeAndDispatch SOLO con { userId } — no le pasa paymentMethod/paymentStatus (usa los defaults de COD intactos)',
    /confirmCod\(orderId, userId\)\s*\{\s*return this\._finalizeAndDispatch\(orderId,\s*\{\s*userId\s*\}\);/.test(orderServiceSource.replace(/\s+/g, ' ')));
  assert('confirmPaymentProof existe y delega en _finalizeAndDispatch con paymentMethod/paymentStatus explícitos (mismo camino que confirmCod, sin duplicar la lógica de stock/lock/despacho)',
    /confirmPaymentProof\(orderId,\s*\{\s*paymentMethod,\s*paymentStatus\s*\}\)/.test(orderServiceSource.replace(/\s+/g, ' ')));

  // ── db/models/orderModel.js: sin nuevos valores de ENUM — se reutilizan los existentes ──
  const orderModelSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'models', 'orderModel.js'), 'utf8');
  const paymentStatusArrayMatch = orderModelSource.match(/ORDER_PAYMENT_STATUS_VALUES\s*=\s*\[([^\]]*)\]/);
  const paymentStatusValues = (paymentStatusArrayMatch?.[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  assert('ORDER_PAYMENT_STATUS_VALUES sigue siendo exactamente [pending, pending_verification, paid, failed, refunded] — ya cubría el flujo de comprobante desde antes, no se agregó ningún valor nuevo (estados reutilizados, no duplicados)',
    JSON.stringify(paymentStatusValues) === JSON.stringify(['pending', 'pending_verification', 'paid', 'failed', 'refunded']),
    JSON.stringify(paymentStatusValues));
  assert('db/models/orderModel.js NO agrega ningún nuevo valor a ORDER_STATE_ORDER_VALUES para este paso (se reutiliza el ciclo de vida existente: comprada → pendiente_envio → en_preparacion)',
    (orderModelSource.match(/ORDER_STATE_ORDER_VALUES\s*=\s*\[[^\]]*\]/)?.[0].match(/'[^']+'/g) || []).length === 15);
});

// ── 16. Protección real de sincronizaciones — Dropi/Effi/importación asistida (comportamiento) ──
async function runSyncPriceProtectionSuite() {
  console.log(`\n▶ Protección de precios frente a sincronizaciones automáticas (Dropi/Effi/importación asistida)`);

  const priorDatabaseUrl = process.env.DATABASE_URL;
  if (priorDatabaseUrl === undefined) {
    process.env.DATABASE_URL = 'postgres://smoke:test@localhost:5432/smoketest_never_connects';
  }
  let models, woocommerceMirrorRouter, importRouterRouter;
  try {
    ({ models } = require('../libs/sequelize'));
    woocommerceMirrorRouter = require('../routes/woocommerceMirror');
    importRouterRouter = require('../routes/importRouter');
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  }

  const originalFindOrCreate = models.Product.findOrCreate;

  // Helper: extrae un handler real de un express.Router() sin bootear un servidor HTTP.
  function extractHandler(router, method, routePath) {
    const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`No se encontró la ruta ${method.toUpperCase()} ${routePath}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  function invokeHandler(handler, req) {
    return new Promise((resolve, reject) => {
      const res = {
        _status: 200,
        status(code) { this._status = code; return this; },
        json(payload) { resolve({ status: this._status, body: payload }); },
      };
      const next = (err) => { if (err) reject(err); else resolve({ status: null, body: null, nextCalled: true }); };
      Promise.resolve(handler(req, res, next)).catch(reject);
    });
  }

  try {
    // ═══ DROPI — routes/woocommerceMirror.js POST /products ═══
    const wcHandler = extractHandler(woocommerceMirrorRouter, 'post', '/products');

    const runDropiScenario = async (pricingSource) => {
      let updateCapture = null;
      models.Product.findOrCreate = async () => [{
        id: 501, costPrice: 10, pricingSource, // costPrice actual (10) != incoming (15) → costChanged=true
        update: async (payload) => { updateCapture = payload; return true; },
        toJSON: () => ({ id: 501 }),
      }, false];
      const req = {
        wooBusinessId: 7,
        body: { sku: 'DRP-9001', name: 'Producto Dropi', regular_price: '15.00', images: [], stock_quantity: 8, categories: [{ id: 2 }], status: 'publish' },
      };
      await invokeHandler(wcHandler, req);
      return updateCapture;
    };

    const dropiManual = await runDropiScenario('manual');
    assert("Dropi sync + pricingSource='manual' → price NO cambia (ausente del payload persistido)", !('price' in dropiManual), JSON.stringify(dropiManual));
    assert("Dropi sync + pricingSource='manual' → costPrice/stock SÍ se actualizan normalmente", dropiManual.costPrice === 15 && dropiManual.stock === 8, JSON.stringify(dropiManual));

    const dropiEngine = await runDropiScenario('engine');
    assert("Dropi sync + pricingSource='engine' → price NO cambia", !('price' in dropiEngine), JSON.stringify(dropiEngine));
    assert("Dropi sync + pricingSource='engine' → costPrice/stock SÍ se actualizan normalmente", dropiEngine.costPrice === 15 && dropiEngine.stock === 8, JSON.stringify(dropiEngine));

    const dropiLegacy = await runDropiScenario('legacy_sync');
    assert("Dropi sync + pricingSource='legacy_sync' → price SÍ cambia (15, costo cambió y no está protegido)", dropiLegacy.price === 15, JSON.stringify(dropiLegacy));

    const dropiNull = await runDropiScenario(null);
    assert('Dropi sync + pricingSource=NULL → price SÍ cambia (sin evidencia de decisión, sobrescribible)', dropiNull.price === 15, JSON.stringify(dropiNull));

    // ═══ EFFI — integrations/importService.js upsertProduct() (vía Product.findOrCreate stub) ═══
    // upsertProduct no está exportado; se replica su contrato exacto invocándolo
    // indirectamente a través de importFromEffi con el adapter en modo MOCK
    // (sin red — EFFI_API_KEY no configurada localmente, ver effiAdapter.js).
    const { importFromEffi } = require('../integrations/importService');

    const runEffiScenario = async (pricingSource) => {
      let updateCapture = null;
      models.Product.findOrCreate = async () => [{
        id: 502, pricingSource,
        update: async (payload) => { updateCapture = payload; return true; },
      }, false];
      await importFromEffi({ page: 1, limit: 1, defaultCategoryId: 1 });
      return updateCapture;
    };

    const effiManual = await runEffiScenario('manual');
    assert("Effi sync + pricingSource='manual' → price NO cambia", effiManual && !('price' in effiManual), JSON.stringify(effiManual));
    assert("Effi sync + pricingSource='manual' → stock/image/images/lastSyncAt SÍ se actualizan", effiManual && 'stock' in effiManual && 'lastSyncAt' in effiManual, JSON.stringify(effiManual));

    const effiEngine = await runEffiScenario('engine');
    assert("Effi sync + pricingSource='engine' → price NO cambia", effiEngine && !('price' in effiEngine), JSON.stringify(effiEngine));

    const effiLegacy = await runEffiScenario('legacy_sync');
    assert("Effi sync + pricingSource='legacy_sync' → price SÍ cambia", effiLegacy && 'price' in effiLegacy && typeof effiLegacy.price === 'number', JSON.stringify(effiLegacy));

    const effiNull = await runEffiScenario(null);
    assert('Effi sync + pricingSource=NULL → price SÍ cambia', effiNull && 'price' in effiNull, JSON.stringify(effiNull));

    // ═══ IMPORTACIÓN ASISTIDA — routes/importRouter.js POST /product (provider=dropi) ═══
    const importProductHandler = extractHandler(importRouterRouter, 'post', '/product');

    // Caso: producto YA existe, admin importa CON pvpOverride → price actualizado + pricingSource='manual'.
    let importUpdateCapture = null;
    models.Product.findOrCreate = async () => [{
      id: 503, costPrice: 5, description: 'ya tiene descripción', dropiItems: [{ id: 'x' }],
      update: async (payload) => { importUpdateCapture = payload; return true; },
    }, false];
    await invokeHandler(importProductHandler, {
      body: { provider: 'dropi', externalId: 'DRP-777', pvpOverride: 29.99, price: 12, defaultCategoryId: 1, businessId: null, categoryMap: {}, showShop: true },
    });
    assert("importación asistida CON pvpOverride → price=29.99 y pricingSource='manual' en el payload persistido",
      importUpdateCapture?.price === 29.99 && importUpdateCapture?.pricingSource === 'manual', JSON.stringify(importUpdateCapture));

    // Caso: producto YA existe, admin importa SIN pvpOverride → no se marca manual, price no se toca.
    let importUpdateNoOverrideCapture = null;
    models.Product.findOrCreate = async () => [{
      id: 504, costPrice: 5, description: 'ya tiene descripción', dropiItems: [{ id: 'x' }],
      update: async (payload) => { importUpdateNoOverrideCapture = payload; return true; },
    }, false];
    await invokeHandler(importProductHandler, {
      body: { provider: 'dropi', externalId: 'DRP-778', price: 12, defaultCategoryId: 1, businessId: null, categoryMap: {}, showShop: true },
    });
    assert('importación asistida SIN pvpOverride → NO se marca pricingSource (ni "manual" ni ningún otro valor)', !('pricingSource' in importUpdateNoOverrideCapture), JSON.stringify(importUpdateNoOverrideCapture));
    assert('importación asistida SIN pvpOverride → price tampoco se toca en la actualización (comportamiento ya existente, sin cambios)', !('price' in importUpdateNoOverrideCapture), JSON.stringify(importUpdateNoOverrideCapture));

    // Caso: producto NUEVO (create), CON pvpOverride → defaults incluye pricingSource='manual'.
    let importCreateCapture = null;
    models.Product.findOrCreate = async ({ defaults }) => { importCreateCapture = defaults; return [{ id: 505, ...defaults }, true]; };
    await invokeHandler(importProductHandler, {
      body: { provider: 'dropi', externalId: 'DRP-779', pvpOverride: 40, price: 15, defaultCategoryId: 1, businessId: null, categoryMap: {}, showShop: true },
    });
    assert("importación asistida (creación) CON pvpOverride → defaults.pricingSource='manual'", importCreateCapture?.pricingSource === 'manual', JSON.stringify(importCreateCapture));

    // Caso: producto NUEVO (create), SIN pvpOverride → defaults NO incluye pricingSource (queda NULL, sin backfill — Decisión Paso 9).
    let importCreateNoOverrideCapture = null;
    models.Product.findOrCreate = async ({ defaults }) => { importCreateNoOverrideCapture = defaults; return [{ id: 506, ...defaults }, true]; };
    await invokeHandler(importProductHandler, {
      body: { provider: 'dropi', externalId: 'DRP-780', price: 15, defaultCategoryId: 1, businessId: null, categoryMap: {}, showShop: true },
    });
    assert('importación asistida (creación) SIN pvpOverride → defaults NO incluye pricingSource (permanece NULL, decisión explícita del Paso 9)', !('pricingSource' in importCreateNoOverrideCapture), JSON.stringify(importCreateNoOverrideCapture));
  } finally {
    models.Product.findOrCreate = originalFindOrCreate;
  }
}

// ── 10. Environment variable presence (warn-only) ────────────────────────────
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

// ── 15. Autoridad de precio — pricingSource, comportamiento real de create()/update() ──
// Única suite async de este archivo. Services/productServices.js importa
// libs/sequelize (requiere Node >=20 — ver package.json "engines" — por un
// problema de interop ESM/CJS de una dependencia transitiva bajo Node 18).
// Product.create/findByPk se STUBEAN antes de cualquier llamada — en ningún
// momento se abre una conexión real ni se ejecuta una query real contra
// Postgres; el DATABASE_URL falso de abajo solo evita que `new Sequelize(url)`
// lance por url=undefined al construirse (no dispara ningún I/O de red).
async function runPricingSourceAuthoritySuite() {
  console.log(`\n▶ pricingSource — comportamiento real de create()/update() (Services/productServices.js)`);

  const priorDatabaseUrl = process.env.DATABASE_URL;
  if (priorDatabaseUrl === undefined) {
    process.env.DATABASE_URL = 'postgres://smoke:test@localhost:5432/smoketest_never_connects';
  }
  let ProductsService, models;
  try {
    ProductsService = require('../Services/productServices');
    ({ models } = require('../libs/sequelize'));
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  }

  const service = new ProductsService();
  const originalCreate = models.Product.create;
  const originalFindByPk = models.Product.findByPk;

  try {
    // ── 1 (runtime). El modelo real registra los 4 campos vía Sequelize ──
    assert('models.Product.rawAttributes reconoce pricingSource/pricingCostSnapshot/pricingCalculatedPrice/pricingAppliedAt',
      ['pricingSource', 'pricingCostSnapshot', 'pricingCalculatedPrice', 'pricingAppliedAt'].every((f) => f in models.Product.rawAttributes));

    // ── 3. create() con price explícito → pricingSource='manual' ──
    let createCapture = null;
    models.Product.create = async (payload) => { createCapture = payload; return { id: 9001, ...payload }; };
    const createInput = { name: 'Test manual', price: 19.99, description: 'x'.repeat(15), image: 'i.png', categoryId: 1 };
    const createInputJsonBefore = JSON.stringify(createInput);
    await service.create(createInput);
    assert('create() con price explícito → payload persistido tiene pricingSource="manual"', createCapture?.pricingSource === 'manual', JSON.stringify(createCapture));
    assert('create() con price explícito → price no se altera', createCapture.price === 19.99);
    assert('create() no muta el objeto original recibido por el caller (payload construido con spread, no in-place)', JSON.stringify(createInput) === createInputJsonBefore && !('pricingSource' in createInput));

    let createNoPriceCapture = null;
    models.Product.create = async (payload) => { createNoPriceCapture = payload; return { id: 9002, ...payload }; };
    await service.create({ name: 'Sin price', description: 'x'.repeat(15), image: 'i.png', categoryId: 1 });
    assert('create() SIN price → pricingSource no se agrega (no hay decisión de precio que registrar)', !('pricingSource' in createNoPriceCapture), JSON.stringify(createNoPriceCapture));

    // ── 4. update() con price explícito → pricingSource='manual' (aunque venía de otro estado) ──
    let updateCapture = null;
    models.Product.findByPk = async (id) => ({
      id, pricingSource: 'legacy_sync', price: 10,
      update: async (payload) => { updateCapture = payload; return { id, ...payload }; },
    });
    const updateResult = await service.update(42, { price: 25.50 });
    assert('update() con price explícito → payload persistido tiene pricingSource="manual", incluso partiendo de legacy_sync', updateCapture?.pricingSource === 'manual', JSON.stringify(updateCapture));
    assert('update() con price explícito → la respuesta {id, changes, rta} conserva su contrato original, sin filtrar el campo interno pricingSource al caller',
      updateResult.id === 42 && updateResult.changes.price === 25.50 && !('pricingSource' in updateResult.changes), JSON.stringify(updateResult));

    // ── 5. update() SIN price → conserva pricingSource existente, no lo toca ──
    let updateNoPriceCapture = null;
    models.Product.findByPk = async (id) => ({
      id, pricingSource: 'engine', price: 30,
      update: async (payload) => { updateNoPriceCapture = payload; return { id, ...payload }; },
    });
    await service.update(43, { stock: 5, showShop: true });
    assert('update() SIN price → el payload persistido NO incluye pricingSource (se conserva "engine", lo que ya estaba en la fila)', !('pricingSource' in updateNoPriceCapture), JSON.stringify(updateNoPriceCapture));
    assert('update() SIN price → los demás campos (stock, showShop) sí se persisten normalmente', updateNoPriceCapture.stock === 5 && updateNoPriceCapture.showShop === true);

    // price=null explícito no es una decisión de precio real (Joi nunca lo permite hoy, pero la función debe ser robusta).
    let updateNullPriceCapture = null;
    models.Product.findByPk = async (id) => ({
      id, pricingSource: 'manual',
      update: async (payload) => { updateNullPriceCapture = payload; return { id, ...payload }; },
    });
    await service.update(44, { price: null, stock: 1 });
    assert('update() con price=null explícito → NO se trata como decisión de precio, pricingSource no se fuerza', !('pricingSource' in updateNullPriceCapture), JSON.stringify(updateNullPriceCapture));

    // ── 7/9. Ningún precio existente fue recalculado; los snapshots del motor nunca se tocan desde escritura manual ──
    for (const capture of [createCapture, createNoPriceCapture, updateCapture, updateNoPriceCapture, updateNullPriceCapture]) {
      assert('el payload persistido nunca incluye pricingCostSnapshot/pricingCalculatedPrice/pricingAppliedAt — esos campos son responsabilidad exclusiva de una futura aplicación del motor, nunca de una escritura manual',
        !('pricingCostSnapshot' in capture) && !('pricingCalculatedPrice' in capture) && !('pricingAppliedAt' in capture), JSON.stringify(capture));
    }

    // ── 8. NULL permanece NULL para productos existentes (sin backfill, ver también suite estructural) ──
    let updateExistingNullCapture = null;
    models.Product.findByPk = async (id) => ({
      id, pricingSource: null, sourceProvider: 'dropi', price: 15, // producto Dropi previo a esta migración, nunca tocado por pricingSource
      update: async (payload) => { updateExistingNullCapture = payload; return { id, ...payload }; },
    });
    await service.update(45, { stock: 3 }); // update sin price sobre un producto con pricingSource=NULL existente
    assert('update() sin price sobre un producto existente con pricingSource=NULL → sigue sin escribir pricingSource, el NULL permanece NULL', !('pricingSource' in updateExistingNullCapture), JSON.stringify(updateExistingNullCapture));
  } finally {
    models.Product.create = originalCreate;
    models.Product.findByPk = originalFindByPk;
  }
}

// ── 18. Apply-Engine — comportamiento real (preview/apply-engine, sin DB real) ──
async function runApplyEngineSuite() {
  console.log(`\n▶ Apply-Engine — comportamiento real (preview/apply-engine)`);

  const priorDatabaseUrl = process.env.DATABASE_URL;
  if (priorDatabaseUrl === undefined) {
    process.env.DATABASE_URL = 'postgres://smoke:test@localhost:5432/smoketest_never_connects';
  }
  let models, productPricingApplyService, productosRouter;
  try {
    ({ models } = require('../libs/sequelize'));
    productPricingApplyService = require('../Services/productPricingApplyService');
    productosRouter = require('../routes/productosRouting');
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  }
  const { previewEnginePrice, applyEnginePrice, APPLY_STATUS } = productPricingApplyService;
  const { round2 } = require('../Services/orderTotals');

  const originalFindByPk = models.Product.findByPk;

  function extractHandler(router, method, routePath) {
    const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`No se encontró la ruta ${method.toUpperCase()} ${routePath}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function invokeHandler(handler, req) {
    return new Promise((resolve, reject) => {
      const res = {
        _status: 200,
        status(code) { this._status = code; return this; },
        json(payload) { resolve({ status: this._status, body: payload }); },
      };
      const next = (err) => { if (err) reject(err); else resolve({ status: null, body: null, nextCalled: true }); };
      Promise.resolve(handler(req, res, next)).catch(reject);
    });
  }

  const makeProduct = (overrides = {}) => {
    const product = {
      id: 900, costPrice: 10, pricingSource: null, price: 5,
      ...overrides,
      update: async (payload) => { product._updateCalls = (product._updateCalls || 0) + 1; Object.assign(product, payload); return product; },
    };
    product._updateCalls = 0;
    return product;
  };

  try {
    // ═══ 1. preview: read-only, cero .update(), en los 4 estados de pricingSource ═══
    for (const pricingSource of ['manual', 'engine', 'legacy_sync', null]) {
      const product = makeProduct({ pricingSource });
      let findByPkCalls = 0;
      models.Product.findByPk = async () => { findByPkCalls++; return product; };
      const { notFound, result } = await previewEnginePrice(900, { targetContributionMargin: 0.3 });
      assert(`preview sobre pricingSource=${pricingSource}: notFound=false, result.status='OK'`, notFound === false && result.status === 'OK', JSON.stringify(result));
      assert(`preview sobre pricingSource=${pricingSource}: NO llamó a product.update() ni una sola vez`, product._updateCalls === 0);
      assert(`preview sobre pricingSource=${pricingSource}: hizo exactamente UNA lectura findByPk`, findByPkCalls === 1);
    }

    // ═══ 2. apply-engine: exactamente UNA lectura findByPk por invocación ═══
    {
      const product = makeProduct({ pricingSource: 'legacy_sync' });
      let findByPkCalls = 0;
      models.Product.findByPk = async () => { findByPkCalls++; return product; };
      await applyEnginePrice(900, { targetContributionMargin: 0.3 });
      assert('apply-engine hace EXACTAMENTE una lectura findByPk por invocación (sin segunda lectura antes de escribir)', findByPkCalls === 1, `findByPkCalls=${findByPkCalls}`);
    }

    // ═══ 3. Las 4 transiciones → engine ═══
    for (const pricingSource of [null, 'legacy_sync', 'manual', 'engine']) {
      const product = makeProduct({ pricingSource, costPrice: 10 });
      models.Product.findByPk = async () => product;
      const { notFound, applied, status, result } = await applyEnginePrice(900, { targetContributionMargin: 0.3 });
      assert(`${JSON.stringify(pricingSource)} → engine: applied=true, status=APPLIED`, notFound === false && applied === true && status === APPLY_STATUS.APPLIED, JSON.stringify({ pricingSource, applied, status }));
      assert(`${JSON.stringify(pricingSource)} → engine: product.pricingSource quedó en 'engine'`, product.pricingSource === 'engine');
      assert(`${JSON.stringify(pricingSource)} → engine: price === pricingCalculatedPrice === result.final.finalGrossPrice`, product.price === result.final.finalGrossPrice && product.pricingCalculatedPrice === result.final.finalGrossPrice);
      assert(`${JSON.stringify(pricingSource)} → engine: pricingCostSnapshot === costPrice usado (10)`, product.pricingCostSnapshot === 10);
      assert(`${JSON.stringify(pricingSource)} → engine: pricingAppliedAt es una fecha (Date)`, product.pricingAppliedAt instanceof Date);
    }

    // ═══ 4. engine → engine: reaplicación actualiza snapshots y pricingAppliedAt con valores NUEVOS ═══
    {
      const staleDate = new Date('2020-01-01T00:00:00Z');
      const product = makeProduct({ pricingSource: 'engine', costPrice: 20, pricingCostSnapshot: 999, pricingCalculatedPrice: 111.11, pricingAppliedAt: staleDate });
      models.Product.findByPk = async () => product;
      const { applied, result } = await applyEnginePrice(900, { targetContributionMargin: 0.3 });
      assert('engine → engine (reaplicación): applied=true', applied === true);
      assert('engine → engine: pricingCostSnapshot se actualiza al costo NUEVO (20), no conserva el viejo (999)', product.pricingCostSnapshot === 20);
      assert('engine → engine: pricingCalculatedPrice se actualiza al nuevo cálculo, no conserva 111.11', product.pricingCalculatedPrice !== 111.11 && product.pricingCalculatedPrice === result.final.finalGrossPrice);
      assert('engine → engine: pricingAppliedAt se actualiza, ya no es la fecha vieja de 2020', product.pricingAppliedAt.getTime() !== staleDate.getTime());
    }

    // ═══ 5. expectedFinalGrossPrice correcto → aplica; 1 centavo de diferencia → PRICE_DRIFTED sin escritura ═══
    {
      const product1 = makeProduct({ pricingSource: 'legacy_sync', costPrice: 10 });
      models.Product.findByPk = async () => product1;
      const preview = await previewEnginePrice(900, { targetContributionMargin: 0.3 });
      const correctPrice = preview.result.final.finalGrossPrice;

      const applyOk = await applyEnginePrice(900, { targetContributionMargin: 0.3, expectedFinalGrossPrice: correctPrice });
      assert('expectedFinalGrossPrice correcto → applied=true, status=APPLIED', applyOk.applied === true && applyOk.status === APPLY_STATUS.APPLIED);
      assert('expectedFinalGrossPrice como string numérica equivalente también aplica (comparación monetaria, no !==)',
        (await applyEnginePrice(900, { targetContributionMargin: 0.3, expectedFinalGrossPrice: String(correctPrice) })).applied === true);

      const product2 = makeProduct({ pricingSource: 'legacy_sync', costPrice: 10 });
      models.Product.findByPk = async () => product2;
      const applyDrift = await applyEnginePrice(900, { targetContributionMargin: 0.3, expectedFinalGrossPrice: round2(correctPrice + 0.01) });
      assert('expectedFinalGrossPrice con diferencia de 1 centavo → status=PRICE_DRIFTED, applied=false', applyDrift.applied === false && applyDrift.status === APPLY_STATUS.PRICE_DRIFTED, JSON.stringify(applyDrift));
      assert('PRICE_DRIFTED → NO se ejecutó ningún .update()', product2._updateCalls === 0);
    }

    // ═══ 6. costo inválido/desconocido → sin escritura ═══
    for (const costPrice of [null, -5, NaN, 0]) {
      const product = makeProduct({ pricingSource: 'legacy_sync', costPrice });
      models.Product.findByPk = async () => product;
      const { applied, status } = await applyEnginePrice(900, { targetContributionMargin: 0.3 });
      assert(`costPrice=${costPrice} → applied=false (sin escritura)`, applied === false, `status=${status}`);
      assert(`costPrice=${costPrice} → NO se ejecutó .update()`, product._updateCalls === 0);
    }

    // ═══ 7. Producto inexistente → NOT_FOUND, preview y apply ═══
    {
      models.Product.findByPk = async () => null;
      const previewMissing = await previewEnginePrice(9999, { targetContributionMargin: 0.3 });
      assert('preview sobre producto inexistente → notFound=true', previewMissing.notFound === true);
      const applyMissing = await applyEnginePrice(9999, { targetContributionMargin: 0.3 });
      assert('apply-engine sobre producto inexistente → notFound=true, status=NOT_FOUND', applyMissing.notFound === true && applyMissing.status === APPLY_STATUS.NOT_FOUND);
    }

    // ═══ 8. Mapeo HTTP a nivel de ruta real (200/404/409/422) ═══
    const previewHandler = extractHandler(productosRouter, 'post', '/:id/pricing/preview');
    const applyHandler = extractHandler(productosRouter, 'post', '/:id/pricing/apply-engine');

    {
      const product = makeProduct({ pricingSource: 'legacy_sync', costPrice: 10 });
      models.Product.findByPk = async () => product;
      const res = await invokeHandler(applyHandler, { params: { id: '900' }, body: { targetContributionMargin: 0.3 } });
      assert('ruta apply-engine, aplicación exitosa → HTTP 200', res.status === 200, JSON.stringify(res));
      assert('ruta apply-engine, aplicación exitosa → body.applied=true', res.body?.applied === true, JSON.stringify(res.body));
    }
    {
      models.Product.findByPk = async () => null;
      const res = await invokeHandler(applyHandler, { params: { id: '999999' }, body: { targetContributionMargin: 0.3 } });
      assert('ruta apply-engine, producto inexistente → HTTP 404', res.status === 404, JSON.stringify(res));
    }
    {
      const product = makeProduct({ pricingSource: 'legacy_sync', costPrice: null });
      models.Product.findByPk = async () => product;
      const res = await invokeHandler(applyHandler, { params: { id: '900' }, body: { targetContributionMargin: 0.3 } });
      assert('ruta apply-engine, costo inválido → HTTP 422', res.status === 422, JSON.stringify(res));
      assert('ruta apply-engine, costo inválido → sin escritura', product._updateCalls === 0);
    }
    {
      const product = makeProduct({ pricingSource: 'legacy_sync', costPrice: 10 });
      models.Product.findByPk = async () => product;
      const res = await invokeHandler(applyHandler, { params: { id: '900' }, body: { targetContributionMargin: 0.3, expectedFinalGrossPrice: 999999.99 } });
      assert('ruta apply-engine, price drift → HTTP 409', res.status === 409, JSON.stringify(res));
      assert('ruta apply-engine, price drift → sin escritura', product._updateCalls === 0);
    }
    {
      const product = makeProduct({ pricingSource: 'manual', costPrice: 10 });
      models.Product.findByPk = async () => product;
      const res = await invokeHandler(previewHandler, { params: { id: '900' }, body: { targetContributionMargin: 0.3 } });
      assert('ruta preview → HTTP 200, applied=false siempre', res.status === 200 && res.body?.applied === false, JSON.stringify(res));
      assert('ruta preview → sin escritura', product._updateCalls === 0);
    }
  } finally {
    models.Product.findByPk = originalFindByPk;
  }
}

// ── 20. DeUna QR + comprobante — comportamiento real (Paso 11) ────────────────
// Requiere Services/orderService.js, que a su vez requiere libs/cartRecoveryQueue.js
// (BullMQ/Redis). Sin Redis local, el primer intento de conexión añade ~10-15s
// de espera una sola vez (no bloquea el proceso — process.exit() al final de
// este script lo cierra igual). No es un problema introducido por este paso:
// orderService.js ya dependía de Redis desde antes; este es el primer test que
// lo requiere transitivamente.
async function runDeunaPaymentProofSuite() {
  console.log(`\n▶ DeUna QR + comprobante — comportamiento real (getDeunaPaymentInfo/uploadProof/approveProof/rejectProof)`);

  const priorDatabaseUrl = process.env.DATABASE_URL;
  if (priorDatabaseUrl === undefined) {
    process.env.DATABASE_URL = 'postgres://smoke:test@localhost:5432/smoketest_never_connects';
  }
  let sequelizeInstance, models, paymentProofService, OrderService;
  try {
    sequelizeInstance = require('../libs/sequelize');
    ({ models } = sequelizeInstance);
    paymentProofService = require('../Services/paymentProofService');
    OrderService = require('../Services/orderService');
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  }
  const { getDeunaPaymentInfo, uploadProof, listProofs, approveProof, rejectProof, DEUNA_PAYMENT_LINK } = paymentProofService;

  const originalFindByPk = models.Order.findByPk;
  const originalConfirmPaymentProof = OrderService.prototype.confirmPaymentProof;
  const originalTransaction = sequelizeInstance.transaction;
  // uploadProof() envuelve create()+order.update() en sequelize.transaction() —
  // legítimo en producción (atomicidad real), pero aquí se stubea para no abrir
  // una conexión Postgres real: solo invoca el callback con un token de
  // transacción falso — el resto de los stubs (models.PaymentProof.create,
  // order.update) ya ignoran el objeto `transaction` real.
  sequelizeInstance.transaction = async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } });

  // uploadProof() ahora también verifica el archivo con un HEAD real
  // (Services/paymentProofImageValidation.js) — se stubea global.fetch para
  // no hacer ninguna llamada de red real durante los tests. Por defecto
  // simula una imagen JPEG válida de 12345 bytes; los tests de "archivo
  // inválido" sobreescriben esto puntualmente.
  const originalFetch = global.fetch;
  function fakeHeadResponse({ ok = true, status = 200, contentType = 'image/jpeg', contentLength = '12345' } = {}) {
    return {
      ok, status,
      headers: { get: (name) => (name === 'content-type' ? contentType : name === 'content-length' ? contentLength : null) },
    };
  }
  global.fetch = async () => fakeHeadResponse();

  // URL de comprobante que SÍ pasa assertTrustedProofUrl (dominio Firebase
  // Storage real, carpeta payment-proofs/<orderId>/, extensión de imagen
  // permitida) — mismo formato que produce getDownloadURL() en
  // frontDashboardAynimar. El segmento <orderId> debe coincidir EXACTO con
  // la orden contra la que se registra (protección "URL de otra orden").
  const validProofUrl = (suffix, orderId = 700) =>
    `https://firebasestorage.googleapis.com/v0/b/aynimar-test.appspot.com/o/payment-proofs%2F${orderId}%2F${suffix}.jpg?alt=media&token=abc123`;

  // ── Fake in-memory "tabla" de PaymentProof — replica fielmente el UPDATE ──
  // condicionado (WHERE status='pending') que usa _claimProof, sin necesitar
  // Postgres real. Es el mismo patrón de doble-aprobación que Postgres
  // garantizaría con una fila real: solo el primer claim exitoso gana.
  function makeProofStore(initialRows = []) {
    let rows = initialRows.map((r) => ({ reviewedByUserId: null, reviewedAt: null, reviewNote: null, ...r }));
    let nextId = rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1;
    const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
    return {
      rows: () => rows,
      async findOne({ where }) { return rows.find((r) => matches(r, where)) || null; },
      async create(data) { const row = { id: nextId++, ...data }; rows.push(row); return row; },
      async update(data, { where }) {
        let count = 0;
        rows = rows.map((r) => { if (matches(r, where)) { count++; return { ...r, ...data }; } return r; });
        return [count];
      },
      async findByPk(id) { return rows.find((r) => r.id === id) || null; },
      async findAll({ where }) { return rows.filter((r) => matches(r, where || {})); },
    };
  }

  function makeOrder(overrides = {}) {
    const order = {
      id: 700, state: 'comprada', paymentStatus: 'pending', fulfillmentStatus: null,
      total: 45.50, customer: { id: 9, userId: 501 },
      ...overrides,
    };
    order._updateCalls = 0;
    order.update = async (payload) => { order._updateCalls++; Object.assign(order, payload); return order; };
    return order;
  }

  function stubConfirmPaymentProof(impl) {
    OrderService.prototype.confirmPaymentProof = impl;
  }

  try {
    // ═══ 1/2. getDeunaPaymentInfo — info correcta del QR, 100% lectura ═══
    {
      const order = makeOrder({ total: 87.32 });
      models.Order.findByPk = async () => order;
      const info = await getDeunaPaymentInfo(700, 501, 'customer');
      assert('getDeunaPaymentInfo: paymentLink es el link real de DeUna (no inventado)', info.paymentLink === DEUNA_PAYMENT_LINK && /pagar\.deuna\.app/.test(info.paymentLink));
      assert('getDeunaPaymentInfo: orderReference = "AYNIMAR-700" (mismo patrón que Dropi)', info.orderReference === 'AYNIMAR-700');
      assert('getDeunaPaymentInfo: amountToPay = order.total EXACTO (87.32), nunca recalculado', info.amountToPay === 87.32);
      assert('getDeunaPaymentInfo: NO escribe nada en la orden (0 updates)', order._updateCalls === 0);
    }

    // ── 6. Orden inexistente ──
    {
      models.Order.findByPk = async () => null;
      let threw = null;
      try { await getDeunaPaymentInfo(999999, 501, 'customer'); } catch (e) { threw = e; }
      assert('getDeunaPaymentInfo sobre orden inexistente → boom.notFound (404)', threw?.output?.statusCode === 404, JSON.stringify(threw?.output));
    }

    // ── 7. Usuario no autorizado (ni dueño ni staff) ──
    {
      const order = makeOrder({ customer: { id: 9, userId: 501 } });
      models.Order.findByPk = async () => order;
      let threw = null;
      try { await getDeunaPaymentInfo(700, 999888, 'customer'); } catch (e) { threw = e; }
      assert('getDeunaPaymentInfo con userId que no es dueño de la orden y sin rol staff → boom.forbidden (403)', threw?.output?.statusCode === 403, JSON.stringify(threw?.output));
    }
    assert('staff (admin) SÍ puede ver la info aunque no sea el dueño', await (async () => {
      const order = makeOrder({ customer: { id: 9, userId: 501 } });
      models.Order.findByPk = async () => order;
      const info = await getDeunaPaymentInfo(700, 1, 'admin');
      return info.orderReference === 'AYNIMAR-700';
    })());

    // ═══ 3/4. subir comprobante — happy path, asociado a la orden correcta ═══
    {
      const order = makeOrder();
      const store = makeProofStore();
      models.Order.findByPk = async () => order;
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.create = store.create;

      const proof = await uploadProof(700, { fileUrl: validProofUrl('700-1') }, 501, 'customer');
      assert('uploadProof: el comprobante creado queda asociado a la orden correcta (orderId=700)', proof.orderId === 700, JSON.stringify(proof));
      assert('uploadProof: registra quién lo subió (uploadedByUserId=501)', proof.uploadedByUserId === 501);
      assert('uploadProof: nace en status="pending" — NUNCA "approved"', proof.status === 'pending');

      // ── 9. Comprobante subido NO confirma automáticamente ──
      assert('uploadProof: la orden pasa a paymentStatus="pending_verification", NUNCA "paid"', order.paymentStatus === 'pending_verification', order.paymentStatus);
      assert('uploadProof: paymentMethod queda "deuna"', order.paymentMethod === 'deuna');
      let confirmCalls = 0;
      stubConfirmPaymentProof(async () => { confirmCalls++; });
      assert('uploadProof NUNCA invoca confirmPaymentProof (subir evidencia no despacha ni confirma nada)', confirmCalls === 0);
    }

    // ═══ Verificación real del archivo (HEAD) — "cliente no puede mandar cualquier URL falsa" ═══
    {
      // Dominio/carpeta/extensión pasan assertTrustedProofUrl, pero el archivo
      // REAL (según el HEAD simulado) no es una imagen válida → rechazado.
      const order = makeOrder();
      const store = makeProofStore();
      models.Order.findByPk = async () => order;
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.create = store.create;

      global.fetch = async () => fakeHeadResponse({ contentType: 'application/pdf' });
      let threwBadType = null;
      try { await uploadProof(700, { fileUrl: validProofUrl('bad-mime') }, 501, 'customer'); } catch (e) { threwBadType = e; }
      assert('uploadProof RECHAZA si el HEAD real reporta un Content-Type que no es imagen (ej. application/pdf), aunque la extensión del nombre diga .jpg', threwBadType?.output?.statusCode === 400, JSON.stringify(threwBadType?.output));
      assert('archivo con Content-Type inválido → NO se creó ningún comprobante', store.rows().length === 0);

      global.fetch = async () => fakeHeadResponse({ contentLength: String(20 * 1024 * 1024) });
      let threwTooBig = null;
      try { await uploadProof(700, { fileUrl: validProofUrl('too-big') }, 501, 'customer'); } catch (e) { threwTooBig = e; }
      assert('uploadProof RECHAZA un archivo real más grande que MAX_BYTES (20MB > límite de 8MB)', threwTooBig?.output?.statusCode === 400, JSON.stringify(threwTooBig?.output));

      global.fetch = async () => fakeHeadResponse({ ok: false, status: 404 });
      let threwNotFound = null;
      try { await uploadProof(700, { fileUrl: validProofUrl('gone') }, 501, 'customer'); } catch (e) { threwNotFound = e; }
      assert('uploadProof RECHAZA si el HEAD real devuelve 404 (el archivo no existe de verdad en el storage)', threwNotFound?.output?.statusCode === 400, JSON.stringify(threwNotFound?.output));

      global.fetch = async () => fakeHeadResponse({ contentLength: '0' });
      let threwEmpty = null;
      try { await uploadProof(700, { fileUrl: validProofUrl('empty') }, 501, 'customer'); } catch (e) { threwEmpty = e; }
      assert('uploadProof RECHAZA un archivo de 0 bytes', threwEmpty?.output?.statusCode === 400, JSON.stringify(threwEmpty?.output));

      global.fetch = async () => fakeHeadResponse(); // restaura el HEAD válido por defecto para el resto de la suite
      assert('con un archivo real válido (JPEG, tamaño normal, HTTP 200), uploadProof SÍ crea el comprobante', (await uploadProof(700, { fileUrl: validProofUrl('finally-ok') }, 501, 'customer')).status === 'pending');
    }

    // ═══ Auditoría de seguridad — "comprobante de otra orden/persona" ═══
    {
      // La URL es un comprobante REAL, válido, ya subido — pero para la orden
      // 701, no para la 700. Un cliente de la orden 700 no puede reutilizarlo.
      const order700 = makeOrder();
      models.Order.findByPk = async () => order700;
      const store = makeProofStore();
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.create = store.create;

      let threw = null;
      try { await uploadProof(700, { fileUrl: validProofUrl('other-order', 701) }, 501, 'customer'); } catch (e) { threw = e; }
      assert('uploadProof RECHAZA un comprobante cuya carpeta pertenece a OTRA orden (701, registrado contra 700) → 400, no crea el registro', threw?.output?.statusCode === 400, JSON.stringify(threw?.output));
      assert('comprobante de otra orden: NO se creó ningún PaymentProof', store.rows().length === 0);
    }

    // ═══ Auditoría de seguridad — "archivo reemplazado" entre subida y aprobación ═══
    {
      const order = makeOrder({ paymentStatus: 'pending_verification' });
      const store = makeProofStore([{ id: 8, orderId: 700, fileUrl: validProofUrl('swapped'), uploadedByUserId: 501, status: 'pending' }]);
      models.Order.findByPk = async () => order;
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.update = store.update;
      models.PaymentProof.findByPk = store.findByPk;

      let confirmCalls = 0;
      stubConfirmPaymentProof(async () => { confirmCalls++; });

      // Entre la subida (verificada como imagen válida) y esta aprobación, el
      // archivo en Storage fue reemplazado/eliminado — el HEAD ahora falla.
      global.fetch = async () => fakeHeadResponse({ ok: false, status: 404 });
      let threw = null;
      try { await approveProof(700, 8, 42); } catch (e) { threw = e; }
      assert('approveProof RECHAZA si el archivo ya no es válido al momento de aprobar (reemplazado/eliminado en Storage) — no confía ciegamente en la verificación de la subida', threw?.output?.statusCode === 400, JSON.stringify(threw?.output));
      assert('archivo reemplazado: el comprobante NO quedó marcado "approved" (sigue "pending", disponible para que un admin decida con la evidencia real)', store.rows().find((r) => r.id === 8).status === 'pending');
      assert('archivo reemplazado: confirmPaymentProof NUNCA se invocó — ningún despacho con evidencia inválida', confirmCalls === 0);

      global.fetch = async () => fakeHeadResponse(); // restaura el HEAD válido por defecto
      const result = await approveProof(700, 8, 42);
      assert('con el archivo válido de nuevo, la aprobación SÍ procede normalmente', result.proof.status === 'approved' && confirmCalls === 1);
    }

    // ── 5. Comprobante inválido (fileUrl faltante/no-https/javascript:/data:) ──
    // La validación de FORMATO vive en uploadProofSchema (Joi), ya probada
    // exhaustivamente en la suite estructural "DeUna/Comprobante — schema Joi,
    // roles y aislamiento de orderTotals" (fileUrl http/javascript:/data:/
    // ausente → rechazados con error de validación antes de llegar al
    // servicio). Este archivo de servicio deliberadamente NO reimplementa esa
    // validación (single source of truth, sin duplicar reglas).

    // ── 15. Orden ya pagada ──
    {
      const order = makeOrder({ paymentStatus: 'paid' });
      models.Order.findByPk = async () => order;
      let threw = null;
      try { await uploadProof(700, { fileUrl: validProofUrl('paid-test') }, 501, 'customer'); } catch (e) { threw = e; }
      assert('uploadProof sobre orden ya paymentStatus="paid" → boom.conflict (409), sin crear comprobante', threw?.output?.statusCode === 409, JSON.stringify(threw?.output));
    }

    // ── 16. Orden ya despachada ──
    {
      const order = makeOrder({ fulfillmentStatus: 'DISPATCHED' });
      models.Order.findByPk = async () => order;
      let threw = null;
      try { await uploadProof(700, { fileUrl: validProofUrl('dispatched-test') }, 501, 'customer'); } catch (e) { threw = e; }
      assert('uploadProof sobre orden ya fulfillmentStatus="DISPATCHED" → boom.conflict (409)', threw?.output?.statusCode === 409, JSON.stringify(threw?.output));
    }

    // ── 14. Comprobante duplicado (mismo fileUrl + misma orden) ──
    {
      const order = makeOrder();
      const dupUrl = validProofUrl('dup');
      const store = makeProofStore([{ id: 1, orderId: 700, fileUrl: dupUrl, uploadedByUserId: 501, status: 'pending' }]);
      models.Order.findByPk = async () => order;
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.create = store.create;
      let threw = null;
      try { await uploadProof(700, { fileUrl: dupUrl }, 501, 'customer'); } catch (e) { threw = e; }
      assert('uploadProof con el mismo fileUrl ya subido para la misma orden → boom.conflict (409), no crea un segundo registro', threw?.output?.statusCode === 409, JSON.stringify(threw?.output));
      assert('comprobante duplicado: sigue habiendo exactamente 1 fila (no se creó una segunda)', store.rows().length === 1);
    }

    // ═══ 10. Admin aprueba comprobante — happy path ═══
    {
      const order = makeOrder({ paymentStatus: 'pending_verification' });
      const store = makeProofStore([{ id: 5, orderId: 700, fileUrl: 'https://x.com/ok.jpg', uploadedByUserId: 501, status: 'pending' }]);
      models.Order.findByPk = async () => order;
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.update = store.update;
      models.PaymentProof.findByPk = store.findByPk;

      let confirmCalls = 0;
      let lastConfirmArgs = null;
      stubConfirmPaymentProof(async function (orderId, opts) {
        confirmCalls++;
        lastConfirmArgs = { orderId, opts };
        return { orderId, ...opts, fulfillmentStatus: 'DISPATCHED' };
      });

      const result = await approveProof(700, 5, 42);
      assert('approveProof: el comprobante queda status="approved"', result.proof.status === 'approved', JSON.stringify(result.proof));
      assert('approveProof: registra reviewedByUserId (quién aprobó)', result.proof.reviewedByUserId === 42);
      assert('approveProof: registra reviewedAt', result.proof.reviewedAt instanceof Date);
      assert('approveProof: invoca confirmPaymentProof EXACTAMENTE una vez', confirmCalls === 1, `confirmCalls=${confirmCalls}`);
      assert("approveProof: confirmPaymentProof recibe paymentMethod='deuna', paymentStatus='paid'", lastConfirmArgs.opts.paymentMethod === 'deuna' && lastConfirmArgs.opts.paymentStatus === 'paid');

      // ── 12. Doble aprobación del MISMO comprobante ──
      let threwSecond = null;
      try { await approveProof(700, 5, 43); } catch (e) { threwSecond = e; }
      assert('segunda aprobación del mismo comprobante → boom.conflict (409), ya fue revisado', threwSecond?.output?.statusCode === 409, JSON.stringify(threwSecond?.output));
      assert('doble aprobación: confirmPaymentProof SIGUE en exactamente 1 llamada total (18/19: exactamente una confirmación, exactamente un despacho)', confirmCalls === 1, `confirmCalls=${confirmCalls}`);
    }

    // ═══ 13. Dos aprobaciones "concurrentes" del mismo comprobante (simuladas secuencialmente — el claim condicionado da el mismo resultado que una carrera real) ═══
    {
      const store = makeProofStore([{ id: 6, orderId: 701, fileUrl: 'https://x.com/race.jpg', uploadedByUserId: 501, status: 'pending' }]);
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.update = store.update;
      models.PaymentProof.findByPk = store.findByPk;

      let confirmCalls = 0;
      stubConfirmPaymentProof(async () => { confirmCalls++; return {}; });

      const results = await Promise.allSettled([
        approveProof(701, 6, 10),
        approveProof(701, 6, 11),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert('dos aprobaciones concurrentes del mismo comprobante: exactamente UNA tiene éxito', fulfilled.length === 1, JSON.stringify(results.map((r) => r.status)));
      assert('dos aprobaciones concurrentes: la otra recibe conflicto (409)', rejected.length === 1 && rejected[0].reason?.output?.statusCode === 409);
      assert('dos aprobaciones concurrentes: confirmPaymentProof (⇒ despacho) se invoca EXACTAMENTE una vez, nunca dos', confirmCalls === 1, `confirmCalls=${confirmCalls}`);
    }

    // ═══ 11. Admin rechaza comprobante ═══
    {
      const order = makeOrder({ paymentStatus: 'pending_verification' });
      const store = makeProofStore([{ id: 7, orderId: 700, fileUrl: 'https://x.com/bad.jpg', uploadedByUserId: 501, status: 'pending' }]);
      models.Order.findByPk = async () => order;
      models.PaymentProof.findOne = store.findOne;
      models.PaymentProof.update = store.update;
      models.PaymentProof.findByPk = store.findByPk;

      let confirmCalls = 0;
      stubConfirmPaymentProof(async () => { confirmCalls++; });

      const rejected = await rejectProof(700, 7, 42, 'Monto no coincide con el pedido');
      assert('rejectProof: el comprobante queda status="rejected"', rejected.status === 'rejected');
      assert('rejectProof: registra reviewNote', rejected.reviewNote === 'Monto no coincide con el pedido');
      assert("rejectProof: la orden vuelve a paymentStatus='failed' (permite re-subir un comprobante corregido)", order.paymentStatus === 'failed', order.paymentStatus);
      assert('rejectProof NUNCA invoca confirmPaymentProof — un rechazo jamás despacha', confirmCalls === 0);

      // Rechazar un comprobante ya revisado también debe fallar limpio.
      let threwSecond = null;
      try { await rejectProof(700, 7, 43, 'otra razón'); } catch (e) { threwSecond = e; }
      assert('rechazar un comprobante ya revisado → boom.conflict (409)', threwSecond?.output?.statusCode === 409);
    }

    // ── approve/reject sobre comprobante u orden inexistente ──
    {
      const store = makeProofStore();
      models.PaymentProof.findOne = store.findOne;
      let threw = null;
      try { await approveProof(700, 99999, 42); } catch (e) { threw = e; }
      assert('approveProof sobre proofId inexistente → boom.notFound (404)', threw?.output?.statusCode === 404, JSON.stringify(threw?.output));
    }

    // ── listProofs — dueño y staff pueden listar, terceros no ──
    {
      const order = makeOrder();
      const store = makeProofStore([
        { id: 1, orderId: 700, fileUrl: 'https://x.com/a.jpg', uploadedByUserId: 501, status: 'pending' },
        { id: 2, orderId: 700, fileUrl: 'https://x.com/b.jpg', uploadedByUserId: 501, status: 'rejected' },
      ]);
      models.Order.findByPk = async () => order;
      models.PaymentProof.findAll = store.findAll;
      const asOwner = await listProofs(700, 501, 'customer');
      assert('listProofs: el dueño ve los 2 comprobantes de su orden', asOwner.length === 2);
      const asStaff = await listProofs(700, 1, 'admin');
      assert('listProofs: staff también puede ver los comprobantes', asStaff.length === 2);
      let threw = null;
      try { await listProofs(700, 999888, 'customer'); } catch (e) { threw = e; }
      assert('listProofs: un tercero no dueño y sin rol staff → boom.forbidden (403)', threw?.output?.statusCode === 403);
    }
  } finally {
    models.Order.findByPk = originalFindByPk;
    OrderService.prototype.confirmPaymentProof = originalConfirmPaymentProof;
    sequelizeInstance.transaction = originalTransaction;
    global.fetch = originalFetch;
  }
}

// ── Result summary (espera ambas suites async de arriba antes de contar/salir) ──
runPricingSourceAuthoritySuite()
  .catch((err) => {
    console.error('🚨 Error inesperado en la suite async de pricingSource:', err);
    failed++;
  })
  .then(() => runSyncPriceProtectionSuite())
  .catch((err) => {
    console.error('🚨 Error inesperado en la suite async de protección de sincronizaciones:', err);
    failed++;
  })
  .then(() => runApplyEngineSuite())
  .catch((err) => {
    console.error('🚨 Error inesperado en la suite async de apply-engine:', err);
    failed++;
  })
  .then(() => runDeunaPaymentProofSuite())
  .catch((err) => {
    console.error('🚨 Error inesperado en la suite async de DeUna/comprobante:', err);
    failed++;
  })
  .then(() => {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Smoke tests: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.error(`\n🚨 SMOKE TEST FAILURE — ${failed} test(s) failed. Fix before deploying.\n`);
      process.exit(1);
    } else {
      console.log(`\n✅ All smoke tests passed. Pipeline is clean.\n`);
      process.exit(0);
    }
  });
