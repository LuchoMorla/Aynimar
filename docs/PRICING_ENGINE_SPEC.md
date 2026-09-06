# Pricing Engine de Aynimar — Technical Implementation Specification

Estado: **DISEÑO, NO IMPLEMENTADO.** Revisión 2 (incorpora auditoría crítica del 2026-09-06 contra el estado real del repositorio). Este documento es la especificación técnica sobre la que se construirá el Pricing Engine, una vez autorizado. No crea ni modifica código, modelos ni migraciones por sí mismo.

Contexto: complementa `docs/PAYMENTS.md` (modelo de IVA/totales de checkout, ya implementado) — este documento cubre la capa de **fijación de precio de catálogo**, que hoy no existe como motor formal (es fijación manual en el dashboard, o la fórmula rota de `woocommerceMirror.js`).

---

## A. Architecture Decision Record

**Decisión:** separar el sistema en responsabilidades conceptuales independientes — Cost Engine, Pricing Engine, Commercial Engine (estructural + presentación psicológica), Tax Engine, Checkout Totals, Profitability Engine — conectadas por contratos de datos explícitos, nunca por lógica compartida ni imports cruzados de "atajo". **La separación es de contratos/responsabilidades, no necesariamente de archivos físicos** — ver sección H para la arquitectura física de Nivel 1.

```
COST ENGINE → PRICING ENGINE → [ECONOMIC FLOOR] → COMMERCIAL ENGINE (estructural, neto)
            → FLOOR VALIDATION → TAX ENGINE → COMMERCIAL ENGINE (presentación, PVP)
            → FINAL PVP → CHECKOUT → PROFITABILITY ENGINE → ANALYTICS → PRICING OPTIMIZATION
```

**Por qué esta arquitectura y no una fórmula única embebida en cada lugar que fija precio** (que es el estado actual — dashboard manual + `woocommerceMirror.js` con su propia fórmula rota): porque hoy existen (al menos) dos caminos distintos para fijar `product.price`, y ya encontramos que uno de ellos tiene una fórmula matemáticamente incorrecta (markup en vez de margen) que nadie notó porque no hay una única fuente de verdad. Centralizar en un Pricing Engine con contrato único elimina esa clase de bug estructuralmente, no solo en la instancia que ya encontramos.

**Invariante no negociable:** ningún precio final puede ser menor al piso económico calculado por el Pricing Engine — **para descuentos/promociones comerciales nuevas.** Esto se garantiza con una barrera de validación explícita (`FLOOR VALIDATION`) entre el Commercial Engine y el Tax Engine. **Excepción explícita y deliberada:** la redención de Ayni-Créditos no pasa por esta barrera — ver sección B.3.1.

**Separación Pricing Engine vs. Checkout Totals:** el Pricing Engine decide precios de **catálogo** (cuándo se crea/edita un producto). Checkout Totals (`orderService.js`, ya implementado) decide totales de **una orden concreta**, usando el `product.price` ya fijado — nunca vuelve a invocar al Pricing Engine. Esta separación ya es cierta hoy de facto; este documento la formaliza para que siga siendo cierta cuando se agregue el motor.

---

## B. Technical Specification — contratos por motor

### B.1 — Cost Engine

**Recibe:** una lista de componentes de costo, no un costo único.

```ts
type CostComponent = {
  key: string;                              // libre — 'product_cost', 'shipping', 'dropi_commission',
                                             // 'payment_fee', 'affiliate_fee', 'packaging', etc.
                                             // NO es un enum cerrado — Dropi es UNA fuente posible, no
                                             // parte de la estructura obligatoria (ver B.1.2).
  kind: 'absolute' | 'percentage';
  scope: 'per_unit' | 'per_order' | 'per_shipment';   // ver B.1.1 — distinción crítica, no cosmética
  base?: 'net_price' | 'gross_price';       // obligatorio solo si kind='percentage'
  status: 'known' | 'estimated' | 'unknown';
  value: number | null;                     // null OBLIGATORIO si status='unknown' — nunca 0
  source: string;                           // 'dropi_catalog' | 'manual_estimate' | 'dropi_liquidation' | ...
};

type CostEngineInput = {
  quantity: number;
  costComponents: CostComponent[];
};
```

**Devuelve:**

```ts
type EconomicCost = {
  fixedAbsoluteCost: number;        // CF — suma normalizada de componentes 'absolute' (known+estimated)
  percentageCostRate: number;       // CV% — suma de componentes 'percentage', normalizados a base='net_price'
  componentsUsed: CostComponent[];  // trazabilidad completa — qué se sumó
  unknownComponents: CostComponent[]; // NUNCA se descartan silenciosamente — se listan explícitamente
  costCoverage: number;             // 0..1 — proporción de componentes known+estimated sobre el total esperado
};
```

**Regla explícita:** un componente `unknown` nunca se trata como `0` de forma silenciosa. Se excluye de la suma (matemáticamente equivalente a 0 *para este cálculo*) pero permanece visible en `unknownComponents`, y `costCoverage < 1` señala que el cálculo es parcial. El consumidor (Pricing Engine → eventualmente el admin) siempre puede mostrar: *"Este precio no considera comisión de pasarela porque su valor real todavía es desconocido."*

**Normalización de base porcentual** (ecuación exacta — corrección obligatoria de la auditoría del 2026-09-06):

```
CV%_sobre_neto = Σ (tasa_i × factor_base_i)

  donde factor_base_i = 1              si base_i = 'net_price'
                       = (1 + TAX_RATE) si base_i = 'gross_price'
```

Razón: una comisión de pasarela típicamente se cobra sobre el monto total transaccionado (PVP, con IVA), no sobre el precio neto. Si `base='gross_price'` con tasa `r`, su costo absoluto es `r × PVP = r × P × (1+TAX_RATE)`. Para expresarlo como tasa equivalente sobre `P` (neto): `tasa_equivalente = r × (1+TAX_RATE)`. Mezclar bases sin esta conversión subestimaría el piso económico silenciosamente.

#### B.1.1 — `per_unit` vs. `per_order` vs. `per_shipment` (crítico — no simplificar)

Verificado contra el código real (`Services/orderService.js`, `dispatchToProviders`): **una sola orden de Aynimar puede generar más de un envío/fulfillment externo.** El método agrupa los ítems de la orden por `product.sourceProvider` (`'dropi'`, `'effi'`, u otros en el futuro) y despacha cada grupo por separado — es decir, si una orden contiene un producto de Dropi y otro de Effi, se generan **dos** órdenes de fulfillment externas, cada una con su propio flete.

Por lo tanto:
- `per_unit` — escala con la cantidad del producto (ej. costo de producto).
- `per_order` — un único costo por toda la orden de Aynimar, independiente de cuántos envíos externos genere (ej. una eventual tarifa de procesamiento propia de Aynimar, si existiera).
- `per_shipment` — un costo por **cada envío/fulfillment externo** dentro de la orden (ej. flete de Dropi, flete de Effi) — **no** es lo mismo que `per_order` cuando la orden se divide en múltiples proveedores.

**Regla de uso en el Pricing Engine (catálogo, por producto individual):** un componente `per_order` o `per_shipment` **nunca** se traduce en un número exacto de costo-por-producto — el Pricing Engine no conoce, al fijar el precio de catálogo, con qué otros productos se comprará ese producto ni cuántos envíos generará. Solo puede incorporarse como una **estimación con supuesto explícito**, marcada `status: 'estimated'`, documentando el supuesto (ej. `"asumiendo 1 unidad por envío"`). Nunca se presenta como el costo real de ese producto — es, en esencia, la formalización de lo que ya hacía la `utilidad_mínima_absoluta` (Modelo C de la investigación previa): un colchón conservador, no una asignación exacta.

**Regla de uso en el Profitability Engine (post-venta, orden/envío real):** el costo real de flete se atribuye **primero al nivel del envío/fulfillment real** (`contribución_envío = ingreso_atribuible − flete_real − comisión_real`). Solo si se necesita un desglose por producto individual dentro de ese envío, se aplica una **regla de asignación explícita** — la más defendible por defecto: **prorrateo por ingreso de línea** (`participación_producto = precio_línea / precio_total_envío`). Ese desglose por producto se marca siempre como **asignado/derivado**, nunca como "el costo real e intrínseco de ese producto" — es una aproximación contable, no un hecho.

#### B.1.2 — Dropi como fuente, no como estructura

El Pricing Engine no tiene lógica del tipo `dropiCommission`/`dropiFreight` como conceptos obligatorios de la fórmula central. Dropi es simplemente **una fuente posible** de valores para componentes genéricos (`key: 'shipping', source: 'dropi_catalog'`, etc.) — mañana puede haber `affiliate_fee`, `marketplace_fee`, `packaging`, u otro proveedor de fulfillment, sin tocar la fórmula.

### B.2 — Pricing Engine

**Fórmula central** (derivación matemática completa en la sección "Matemática — referencia" más abajo):

```
P_min = CF / (1 − CV% − M)
```

**Válida únicamente después de normalizar todas las bases porcentuales según B.1** — mezclar una tasa expresada sobre PVP con otra sobre precio neto sin la conversión produce un piso incorrecto (subestimado). Esta fórmula asume `CV%` ya es el agregado normalizado, nunca una suma directa de tasas con bases distintas.

**Casos especiales — comportamiento definido explícitamente:**

| Caso | Comportamiento |
|---|---|
| `CV% > 0` | Caso normal, fórmula general aplica tal cual (bases ya normalizadas) |
| `CF = 0` | Válido matemáticamente (`P_min=0`); el motor emite `warning` y **no** lo entrega como `recommendedNetPrice` sin que también se calcule `marginTargetNetPrice` (basado en costo de producto puro) — el `max()` de ambos sigue aplicando |
| `M = 0` | Válido solo con override explícito; `warning: "operando sin margen objetivo"` — nunca un default silencioso |
| `CV% + M ≥ 1` | **Inválido.** `valid: false`, sin `recommendedNetPrice` numérico — el motor debe rechazar, nunca devolver un precio negativo o infinito |
| Componente `unknown` | Excluido de la suma (ver B.1), `confidence` baja (ver B.2.1), `warnings` lista cuáles |
| Valor negativo en un componente | Rechazado en validación de `CostComponent` — un costo nunca es negativo (un rebate/subsidio es un concepto distinto, no soportado por este contrato) |
| Producto/línea gratuita ($0 intencional) | **No se modela como `product.price=0` en el catálogo.** Ver B.3.2 — es una excepción de contexto comercial concreto (línea de bundle/promoción), nunca un valor permanente del catálogo base |
| Bundle | Se modela como un input propio del Cost Engine (sus propios `costComponents` agregados) — no hay caso especial en la fórmula, el bundle es "un producto más" desde la perspectiva del Pricing Engine |
| Cantidad > 1 | La agrega el Cost Engine (`scope: 'per_unit'` escala, `'per_order'`/`'per_shipment'` no) — el Pricing Engine recibe `CF`/`CV%` ya resueltos, no necesita saber de cantidades |
| Costo `per_order`/`per_shipment` en el piso de catálogo | Solo como estimación explícita (B.1.1) — el `warning` correspondiente debe indicar el supuesto usado |

#### B.2.1 — Umbrales de `confidence` (definidos explícitamente, no a criterio del implementador)

```
costCoverage ≥ 0.90            → confidence = 'high'
0.50 ≤ costCoverage < 0.90     → confidence = 'medium'
costCoverage < 0.50            → confidence = 'low'
```

`costCoverage` = proporción de componentes de costo esperados que están en `'known'` o `'estimated'` (nunca `'unknown'`) sobre el total de componentes relevantes para ese producto/contexto.

**Devuelve:**

```ts
type PricingResult = {
  minimumNetPrice: number;          // P_min — piso absoluto, nunca perforable por descuentos/promociones
  marginTargetNetPrice: number;     // costo_producto / (1 − margen_objetivo) — sobre costo puro
  recommendedNetPrice: number;      // max(minimumNetPrice, marginTargetNetPrice)
  targetContributionMargin: number; // M usado
  economicCost: EconomicCost;       // trazabilidad completa desde Cost Engine
  confidence: 'high' | 'medium' | 'low';  // ver B.2.1
  warnings: string[];
  valid: boolean;                   // false si CV%+M>=1 u otra condición irresoluble
};
```

Deliberadamente **no** incluye un "priceRange" con techo — el Pricing Engine define el piso; un techo (si se decide tener uno) es una decisión del Commercial Engine, no económica.

**Política de redondeo del piso (precisión 2026-09-06 — corrección de auditoría):** `minimumNetPrice` y `marginTargetNetPrice` se redondean **siempre hacia arriba** a 2 decimales (`ceil`, no `round` al más cercano). Razón: un redondeo al más cercano puede dejar el precio realmente cobrado por debajo del mínimo matemático exacto (ej. `2.60/0.70 = 3.714285...` redondea a `3.71` con redondeo convencional, pero el margen de contribución REAL a `3.71` es 29.92%, no 30%). Solo el redondeo hacia arriba garantiza `contribución/precio ≥ M` siempre, no "en promedio". Esto es exclusivo de estos dos campos — `round2` (redondeo al más cercano, ya implementado en `orderTotals.js`) sigue siendo correcto para `subtotal`/`tax`/`total` de checkout y para `fixedAbsoluteCost`/`percentageCostRate` del Cost Engine, que son sumas/agregaciones, no garantías de piso.

**`minimum_contribution_absolute` — corrección de inconsistencia (2026-09-06):** este documento lo listaba en la tabla de Configuración (sección F) y en Migraciones (#4) como parámetro del Pricing Engine, pero el contrato `PricingResult` (arriba) nunca lo recibía ni lo usaba — inconsistencia real, detectada por auditoría. Análisis: **no es reducible a un `CostComponent`** — a diferencia de un costo real, `minimum_contribution_absolute` es una utilidad mínima deseada en dólares, que NO debe volver a dividirse por `(1−M)` (si se modelara como costo, la fórmula la "inflaría" incorrectamente tratando el margen mínimo deseado como si él mismo necesitara margen adicional). Le corresponde ser un **tercer término aditivo, propio**: `costoPuro + minimum_contribution_absolute` (sin dividir por `(1-M)`), comparado con `max()` junto a `minimumNetPrice`/`marginTargetNetPrice`. **Queda fuera del Paso 2 explícitamente**: (a) el Paso 2 autorizado fue literalmente `P_min = CF/(1−CV%−M)`, sin este tercer término; (b) no existe todavía ninguna fuente real del valor (`pricing_config`, migración #4, sigue sin crearse) — implementarlo ahora significaría inventar el número. Se incorpora cuando exista `pricing_config` y se autorice explícitamente, probablemente como parte de conectar el Pricing Engine al catálogo (Commercial Engine o un paso dedicado antes de este).

### B.3 — Commercial Engine (dos fases)

**Fase estructural** (bundles, descuentos, anchoring — opera en precio **neto**):

```ts
type CommercialCandidate = {
  proposedNetPrice: number;
  strategy: string;      // 'manual_override' | 'margin_default' | 'discount_applied' | 'bundle' | ...
  rationale: string;
};
```

**Barrera obligatoria** (todo candidato de descuento/promoción comercial la atraviesa, sin excepción):

```ts
type FloorValidationResult = {
  status: 'APPROVED' | 'REJECTED' | 'ADJUSTED';
  finalNetPrice: number;   // = candidato si APPROVED; clamp al piso si ADJUSTED
  reason?: string;
};

function validateFloor(candidate: CommercialCandidate, pricing: PricingResult): FloorValidationResult;
```

#### B.3.1 — Ayni-Créditos: explícitamente FUERA del alcance de `FLOOR VALIDATION`

**`computeCreditRedemption` (`Services/orderTotals.js`, ya implementado y correcto) NO pasa por `FLOOR VALIDATION`.** Es un mecanismo de pago/redención ya existente, validado en Fase A/B, y fuera del alcance del nuevo Commercial Engine.

**Por qué es correcto que sea así, no solo una excepción de conveniencia:** un descuento comercial (cupón, promoción) reduce ingreso sin ninguna compensación previa — por eso necesita el piso económico como guardia. Un Ayni-Crédito ya representa un valor que Aynimar reconoció y "pagó" en el momento en que el cliente lo ganó (dominio de reciclaje, `Services/commissionService.js`) — su redención en el checkout no es una nueva erosión de margen en el mismo sentido, es la liquidación de una obligación ya asumida.

`FLOOR VALIDATION` aplica **únicamente** a descuentos/promociones comerciales *nuevas* que el Commercial Engine proponga (cupones, ofertas por temporada, precios manuales por debajo del recomendado) — nunca a la redención de créditos existente. **Esta implementación no modifica `computeCreditRedemption` ni ninguna parte del checkout actual.**

#### B.3.2 — Producto/línea gratuita: excepción de contexto, no de catálogo

Un precio por debajo del piso económico (ej. "regalo con la compra") **nunca** se implementa fijando `product.price = 0` de forma permanente en el catálogo — eso contaminaría la venta individual y standalone de ese producto, no solo el contexto promocional. Debe modelarse como una excepción **a nivel de línea de bundle/promoción concreta**, con override explícito y auditable (`allowBelowFloor: true` + `reason` + quién/cuándo lo autorizó), aplicada únicamente dentro del Commercial Engine para esa oferta específica. El precio base del catálogo (`product.price`) permanece siempre protegido por el piso económico.

**Fase de presentación** (redondeo psicológico — opera en **PVP**, después de Tax Engine):

```ts
type RoundingStrategy = (grossPrice: number) => number;  // DEBE cumplir: resultado >= grossPrice

const ROUND_99: RoundingStrategy = ...;
const ROUND_95: RoundingStrategy = ...;
const ROUND_90: RoundingStrategy = ...;
const PREMIUM_ROUND: RoundingStrategy = ...;  // siguiente dólar entero
const EXACT: RoundingStrategy = (p) => p;

// Guardia externa OBLIGATORIA — no confiar solo en que la estrategia esté bien implementada:
function applyRounding(grossPrice: number, strategy: RoundingStrategy): number {
  return Math.max(strategy(grossPrice), grossPrice);
}
```

La estrategia activa es **configuración** (ver sección F), nunca hardcodeada en el motor.

### B.4 — Tax Engine (ya existe — solo formalizar contrato, no reescribir)

```ts
toGross(netPrice: number, taxRate: number): { netPrice, taxRate, taxAmount, grossPrice };
extractFromGross(grossPrice: number, taxRate: number): { grossPrice, taxRate, base, taxAmount };
```

`extractFromGross` **ya está implementado** dentro de `computeOrderTotals()` en `orderTotals.js` — no se toca. `toGross` es la única función nueva, para uso exclusivo del Pricing Engine al fijar precio de catálogo. Ambas direcciones comparten la misma constante `TAX_RATE` (única fuente, `orderTotals.js`) — `taxRate` es siempre un **parámetro** de estas funciones, nunca un valor hardcodeado dentro de ellas.

**Checkout nunca recalcula IVA de forma independiente** — ya es cierto hoy (`checkout()` llama únicamente a `computeOrderTotals`), y este diseño no lo cambia.

### B.5 — Profitability Engine (solo lectura, futuro)

```ts
type ProfitabilitySnapshot = {
  revenueNet: number;              // derivado de order.total persistido — real
  productCost: number | null;      // real si orders_products captura el snapshot de costo (ver C) — si no, estimado desde cost_price actual (puede haber derivado)
  fulfillment: number | null;      // atribuido primero al ENVÍO real (B.1.1), null hasta Nivel 2
  dropiCommission: number | null;  // null hasta Nivel 2
  paymentCommission: number | null;// null hasta pasarela real + Nivel 2
  otherVariableCosts: number | null;
  contributionBeforeCAC: number | null;  // DERIVADO — null si falta cualquier input
  cac: number | null;              // desde atribución de canal, Nivel 4+
  contributionAfterCAC: number | null;   // DERIVADO
};
```

`AOV`, `contributionBeforeCAC`, `contributionAfterCAC` **nunca se persisten como columnas** — se calculan on-demand en el reporte, siempre desde los datos primarios ya guardados.

---

## C. Data Model Proposal — el gap de precio histórico

**Auditoría confirmada del estado actual** (`db/models/order-productModel.js`):

```js
OrderProductSchema = { id, createdAt, amount, orderId, productId, selectedDropiId }
```

**No existe ningún campo de precio ni de costo.** `checkout()`/`_finalizeAndDispatch()` leen `product.price` (vigente en el momento de la orden) para calcular `lineItems`, pero ese valor nunca se escribe de vuelta a `orders_products`. Si `product.price` cambia después, la orden histórica pierde para siempre el precio real al que se vendió esa línea.

**Campos faltantes (GAP):**
- `orders_products.unit_price_gross` (DECIMAL(10,2), nullable) — PVP vigente al momento de la venta.
- `orders_products.unit_cost_snapshot` (DECIMAL(10,2), nullable) — costo de producto vigente al momento de la venta.

**Dónde se congelan:** en el mismo punto donde hoy se lee `product.price` para armar `lineItems` — dentro de `checkout()` (línea ~1103) y `_finalizeAndDispatch()` (línea ~396). Se escriben junto a la creación/actualización de cada fila de `orders_products`, en la misma transacción.

**Qué NO debe recalcularse después:** una vez escrito, `unit_price_gross`/`unit_cost_snapshot` son inmutables — ni una resincronización de Dropi, ni una edición manual del precio, ni una futura corrección de fórmula deben tocarlos. Son snapshots históricos, no valores derivados en vivo.

**Semántica de `unit_cost_snapshot` cuando el costo es desconocido (precisión 2026-09-06):** se define como `NULL` cuando `products.cost_price` es `NULL` en el momento de la venta — **nunca `0`**. Hoy `products.cost_price` solo tiene dos estados posibles (un número real proveniente de Dropi, o `NULL` si nunca se capturó) — no existe un estado "estimado" propio a nivel de producto. Por eso una sola columna `DECIMAL(10,2) NULL` es suficiente para preservar la semántica `unknown` sin necesitar una columna de metadata/estado adicional en `orders_products`. **Si en el futuro `products.cost_price` adquiere su propio estado `estimated`** (ej. un costo aproximado antes de la primera sincronización real con Dropi), `unit_cost_snapshot` necesitará una columna de estado equivalente — se documenta aquí como decisión diferida, no como gap ignorado.

**Sobre descuento/crédito por línea:** no se persiste un desglose de crédito por línea — los créditos se aplican a nivel de orden (`orders.subtotal − orders.total`, ya derivable sin columna nueva, ver sección B). Si algún día se necesita atribuir cuánto crédito "correspondió" a cada línea de un pedido multi-producto, se calcula por **prorrateo de ingreso** en el momento del reporte — mismo principio que B.1.1 para flete: es un valor asignado/derivado, no un hecho primario, y no se almacena.

**Nota sobre IVA histórico:** si el `TAX_RATE` cambiara en el futuro (cambio de régimen SRI), reconstruir el IVA de una orden vieja usando la tasa vigente hoy sería incorrecto para esa orden. `orders.tax` ya está persistido a nivel de orden (correcto para ese caso). No se persiste IVA por línea — se considera una precisión de Nivel 4+, no necesaria ahora; se documenta como limitación conocida, no como omisión silenciosa.

**Por nivel de madurez — dónde vive cada dato:**

**Nivel 1** — no requiere ninguna tabla/columna nueva para que el Pricing Engine funcione (opera como funciones puras + configuración global — sección F).
**Nivel 2** — los valores de `CostComponent` se vuelven reales; viven en la configuración global de Nivel 1 (`pricing_config`), sin nueva entidad de dominio.
**Nivel 3** — requiere `unit_price_gross`/`unit_cost_snapshot` (ya capturados desde Nivel 1, ver Implementation Plan) + captura de eventos de funnel (probablemente herramienta externa de analítica, fuera de alcance de este documento).
**Nivel 4** — requiere atribución de canal/campaña, probablemente `orders.channel`/`orders.campaign` (nullable, nuevo, diferido — no hay evidencia hoy de que Aynimar haga adquisición pagada).
**Nivel 5-6** — reportería/estadística, sin nuevo schema de dominio previsible hoy.

---

## D. Migration Plan — identificadas, NINGUNA ejecutada

**Cambio respecto a la versión anterior de este documento:** se elimina la migración de `orders.credits_applied` (dato derivable — `creditsUsed = orders.subtotal − orders.total`, exacto en todos los casos dado cómo `computeCreditRedemption` está implementado; persistirlo violaría el principio ya adoptado por el proyecto de no duplicar valores derivados). Se simplifica `pricing_config` a una única fila de configuración global para Nivel 1.

| # | Tabla | Campo | Tipo | Propósito | ¿Obligatoria? | ¿Rompe compatibilidad? | Migración de datos existentes | ¿Segura sin afectar producción? |
|---|---|---|---|---|---|---|---|---|
| 1 | `orders_products` | `unit_price_gross` | DECIMAL(10,2), nullable | Snapshot histórico de precio por línea | **Capturar desde el inicio de la implementación** (el uso analítico es Nivel 3, pero cada día sin capturarlo es historial irrecuperable) | No — aditiva | Ninguna — filas existentes quedan `NULL`, no se puede reconstruir honestamente el pasado | Sí — `addColumn` puro, mismo patrón que Fase A/B |
| 2 | `orders_products` | `unit_cost_snapshot` | DECIMAL(10,2), nullable | Costo histórico por línea, para Profitability Engine real | Igual que #1 — capturar desde el inicio, usar en Nivel 3 | No — aditiva | Ninguna | Sí |
| 3 | ~~`orders.credits_applied`~~ | — | — | — | **ELIMINADA** — dato derivable de `subtotal−total`, no se persiste | — | — | — |
| 4 | nueva tabla `pricing_config` | `target_contribution_margin`, `minimum_contribution_absolute`, `rounding_strategy` | tabla nueva, **una sola fila global para Nivel 1** (sin columna de categoría todavía) | Configuración de negocio editable sin deploy (sección F) | Necesaria para que el Pricing Engine tenga de dónde leer parámetros | No — tabla nueva | N/A | Sí |
| 5 | `orders` | `channel`, `campaign` | STRING, nullable | Atribución CAC (Nivel 4) | Solo si Aynimar hace adquisición pagada — **a confirmar, no asumido** | No — aditiva | Ninguna | Sí |

**Soporte por categoría en `pricing_config`** queda explícitamente diferido — se introduce en una fase posterior únicamente si los datos de Nivel 3 muestran que un margen único para todo el catálogo es insuficiente. No se construye por anticipado.

**Ninguna de estas migraciones repite el antipatrón ya reparado** (`createTable(TABLA, schema-en-vivo-del-modelo)`) — todas son `addColumn`/`createTable` con schema explícito y congelado en el propio archivo de migración.

---

## E. Test Plan

**Cost Engine:** agregación correcta de componentes absolutos/porcentuales/mixtos; normalización de base (`gross_price`→`net_price`, fórmula de B.1); componente `unknown` nunca contamina la suma pero sí aparece en `unknownComponents`; `costCoverage`/`confidence` correctos según los umbrales de B.2.1; distinción `per_unit`/`per_order`/`per_shipment` — test explícito de que un costo `per_shipment` **no** se multiplica por la cantidad de unidades ni se confunde con `per_order` cuando hay proveedores mixtos.

**Pricing Engine — costos base:** $2.60, $5, $10, $25, $50.
**Costos porcentuales:** 0%, 5%, 10%, combinación de múltiples comisiones simultáneas (incluyendo mezcla de bases `net_price`/`gross_price` — verificar que la normalización se aplique antes de sumar).
**IVA:** 15%.
**Margen:** 0%, 20%, 30%, 50%.
**Edge cases obligatorios:**
- `CV% + M ≥ 1` → `valid: false`.
- Componente `unknown` → excluido de la suma, presente en warnings, `confidence` refleja el umbral correcto.
- `CF = 0` → válido, con warning, `max()` con `marginTargetNetPrice` sigue aplicando.
- Precio resultante negativo → imposible por construcción; test que lo confirme.
- Descuento comercial que llevaría el precio por debajo del piso → `FLOOR VALIDATION` → `REJECTED`/`ADJUSTED`, nunca `APPROVED`.
- **Redención de Ayni-Créditos que lleva el precio por debajo del piso económico → debe permitirse sin pasar por `FLOOR VALIDATION`** (test explícito de la excepción de B.3.1, para que quede protegida contra una futura "corrección" accidental).
- Redondeo psicológico que en teoría bajaría del piso → `applyRounding` nunca reduce el precio.

**Propiedad matemática a probar en todo el espacio de inputs válidos:**
```
finalPrice >= minimumEconomicPrice   — para descuentos/promociones comerciales
```
```
creditRedemption puede resultar en amountToPay < minimumEconomicPrice — es válido y esperado, no es un bug
```

**Integración (regresión — deben seguir pasando exactamente igual, sin tocarlos):** los 69 smoke tests actuales; CP4/CP6/CP7/CP8 de `checkoutIntegrationTest.js`; el flujo COD completo; que `orderService.js` **no importe** el nuevo módulo de Pricing Engine (test estructural — sección G).

---

## F. Configuración — ENV vs. DATABASE vs. CODE

| Parámetro | Dónde | Por qué |
|---|---|---|
| `TAX_RATE` (15%) | **CODE** (`orderTotals.js`, ya así) | Hecho legal (tasa SRI), no preferencia de negocio — un cambio de régimen debe pasar por revisión de código + tests |
| `target_contribution_margin`, `minimum_contribution_absolute`, `rounding_strategy` | **DATABASE** (`pricing_config`, una fila global — migración #4) | Decisiones de negocio que cambian sin deploy — exactamente lo que `DROPI_MARGIN_PERCENT` en Railway hizo mal: una decisión comercial escondida en variable de infraestructura, invisible y sin auditoría |
| Valores reales de `CostComponent` (comisión Dropi real, comisión pasarela real) | **DATABASE**, una vez confirmados (Nivel 2) | Cambian por negociación comercial con terceros, no por release de código |
| La fórmula matemática, la lógica de validación, el conjunto de `RoundingStrategy` disponibles | **CODE** | No son decisiones de negocio, son la implementación de las decisiones |

---

## Matemática — referencia completa

```
Contribution = P − CF − P×CV%
Margin = Contribution / P ≥ M

P − CF − P×CV% ≥ M×P
P×(1 − CV% − M) ≥ CF
P_min = CF / (1 − CV% − M)          [requiere CV%+M < 1, y CV% ya normalizado — ver B.1]
```
Con `CV%=0`: colapsa exactamente a `CF/(1−M)`, la fórmula ya implementada en `checkout()`/`orderTotals.js`.

**Normalización de base porcentual** (repetida aquí por ser condición previa de validez de la fórmula anterior):
```
CV%_sobre_neto = Σ (tasa_i × factor_base_i)
  factor_base_i = 1              si base_i = 'net_price'
                 = (1 + TAX_RATE) si base_i = 'gross_price'
```

---

## Compatibilidad con lo ya implementado — NO se modifica

El Pricing Engine **nunca** es invocado por `checkout()`, `_finalizeAndDispatch()`, `confirmCod()` ni ningún camino de Checkout Totals — esos siguen usando exclusivamente `product.price` ya fijado + Tax Engine (`computeOrderTotals`/`computeCreditRedemption`, **sin cambios**). Esta implementación **no debe modificar** la lógica ya validada de:

- IVA (extracción, nunca suma hacia adelante);
- créditos (`computeCreditRedemption` intacto, incluida su exención explícita de `FLOOR VALIDATION` — B.3.1);
- idempotencia (lock de fila en `_finalizeAndDispatch`);
- protección de doble confirmación (409 en segunda confirmación concurrente);
- flujo COD (`confirmCod`);
- descuento de stock (guard anti-negativo, TOCTOU);
- despacho a Dropi (`dispatchToProviders`, claim atómico vía `fulfillmentRetryCount`).

Por diseño, esto es **estructuralmente imposible de romper** si el Pricing Engine solo participa en el momento de crear/editar un producto, nunca en el momento de venderlo — la barrera es arquitectónica, no una promesa.

---

## G. Riesgos

- **Económico:** si `minimum_contribution_absolute` se fija sin dato real de flete, sigue existiendo riesgo de vender con pérdida en productos baratos — mitigado, no eliminado, hasta Nivel 2.
- **Tributario:** si el régimen SRI de Aynimar cambia, `TAX_RATE` deja de ser válido — mantenerlo en código con tests obliga a que el cambio sea deliberado.
- **Asignación de costos por envío (B.1.1):** cualquier desglose de flete/comisión por producto es una aproximación (prorrateo), no un hecho — debe presentarse siempre etiquetado como tal para no generar falsa precisión en reportes de rentabilidad.
- **Doble redondeo:** el precio "sugerido" al admin en catálogo y el efectivamente cobrado en checkout pueden diferir en 1 centavo por redondeos independientes — aceptable, documentado, no es un bug.
- **Regresión estructural (el más serio):** que alguien conecte el Commercial/Pricing Engine directamente dentro de `checkout()`, o que la excepción de créditos (B.3.1) se pierda en una futura "limpieza de código" y créditos empiece a pasar por `FLOOR VALIDATION`, rompiendo compras que hoy funcionan. Mitigación: tests estructurales explícitos para ambos casos (sección E).
- **Comercial:** un piso mal calibrado podría encarecer el catálogo de productos baratos hasta la no-competitividad — riesgo de negocio, se revisa con datos de Nivel 3.

---

## H. Implementation Plan (orden recomendado, solo tras autorización)

**Arquitectura física de Nivel 1** (corrección de sobre-diseño): **no** se crean 4-5 archivos/módulos separados. Un único módulo nuevo `Services/pricingEngine.js` contiene, como funciones/namespaces claramente separados pero co-ubicados: Cost Engine, Pricing Engine, Commercial Engine (estructural + presentación psicológica). Tax Engine sigue viviendo donde ya está (`orderTotals.js`, sin fragmentarlo). Profitability Engine queda diferido a una fase posterior (depende de que existan datos reales que leer). Esto es consistente con cómo `orderTotals.js` ya concentra varias responsabilidades relacionadas en un solo archivo cohesivo — no microservicios, no fragmentación prematura.

1. `Services/pricingEngine.js` — Cost Engine: `CostComponent`, agregación, normalización de base, `per_unit`/`per_order`/`per_shipment` — funciones puras + tests (cero dependencias externas).
2. Mismo archivo — Pricing Engine: fórmula general + casos especiales + umbrales de `confidence` + tests (depende solo de #1).
3. Mismo archivo — Floor Validation — barrera pura + tests, incluyendo el test explícito de que créditos NO pasan por aquí (B.3.1).
4. `orderTotals.js` — agregar `toGross()` (cambio mínimo; `extractFromGross` ya existe, no se toca).
5. Mismo archivo `pricingEngine.js` — Commercial Engine: fase estructural (precio manual, sin bundles/descuentos todavía) + `RoundingStrategy` + tests.
6. Reemplazar `applyMargin()` en `woocommerceMirror.js` por una llamada a Pricing+Tax Engine — resuelve el bug pendiente (markup vs. margen) como parte natural del rollout.
7. Migración `orders_products.unit_price_gross` + `unit_cost_snapshot` (tabla D) + wiring en `checkout()`/`_finalizeAndDispatch()` — captura desde ahora, consumo diferido a Nivel 3.
8. Migración `pricing_config` (fila única global) + wiring de lectura desde el Pricing Engine.
9. Dashboard: mostrar el precio recomendado del Pricing Engine como **sugerencia**, nunca auto-aplicado sin confirmación del admin.
10. Profitability Engine (solo lectura) — fase posterior, depende de que #7 ya tenga datos reales.
11. Suite completa de regresión (smoke tests + CP4/CP6/CP7/CP8 en staging) antes de considerar cualquier fase "cerrada".

Se eliminó del plan el paso de migración de `credits_applied` (ya no existe como migración — sección D).
