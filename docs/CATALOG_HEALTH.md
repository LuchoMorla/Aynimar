# Salud del catálogo

Módulo interno para decidir qué hacer con productos problemáticos. **El sistema detecta y propone; el
propietario decide en el panel; queda registro.** Nada se corrige solo: las únicas acciones que tocan el
producto son `hide` y `swap_dropi_id`, y solo cuando el propietario las elige.

Archivos: `Services/catalogHealthService.js`, `routes/catalogHealthRouter.js`, `db/models/catalogIssueModel.js`,
migración `20261020000001-create-catalog-issues.js`, `scripts/catalog-health-seed.js`, `scripts/catalog-health-test.js`.

## API (`/api/v1/catalog-health`, JWT + rol `admin` en todas)

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/?status=open\|decided\|dismissed\|all` (por defecto `open`) | — | `{ generatedAt, summary: { open, bySeverity: {critical, high, medium, low} }, items: [...] }` |
| POST | `/scan` | — | `{ created, updated, resolved }` |
| POST | `/import` | `{ rows: [...] }` (columnas de `margenes.csv`) | `{ created, updated, resolved, skipped: [{ id, reason }] }` |
| POST | `/:id/decision` | `{ action, params?, note? }` | el item actualizado |

Item: `{ id, productId, productName, productPrice, dropiProductId, type, severity, title, details, suggestions: [{ action, label, params }], status, decision: { action, params, note, decidedBy, decidedAt } | null, createdAt, updatedAt }`.
`summary` cuenta siempre los abiertos, sea cual sea el filtro. `status=all` incluye también los `resolved`.
Orden: severidad (critical primero), luego producto.

Errores: 400 validación (Joi), 401 sin token, 403 sin rol admin, 404 issue inexistente, **409 si el issue ya no está abierto**
(decidido, descartado o resuelto), 422 si `swap_dropi_id` en un pack cuyo ID anterior no está entre sus componentes.

### Decisiones

| action | Efecto en el mismo request (transacción, `SELECT … FOR UPDATE`) | status |
|---|---|---|
| `swap_dropi_id` | `params.dropiProductId` (solo dígitos) → `products.dropi_product_id`; en `dropi_items` se sustituye la entrada con el ID anterior (o queda `[{id, qty:1}]` si no había). Se guardan `previousDropiProductId` y `previousDropiItems` en `decision.params` para revertir a mano. `external_id` no se toca (el despacho prioriza `dropiProductId`). | decided |
| `hide` | `products.show_shop = false` (se guarda `previousShowShop`) | decided |
| `set_price` | solo se registra (`params.price`); se aplica con la edición de producto existente | decided |
| `bundle_only` | solo se registra | decided |
| `keep` | solo se registra | decided |
| `dismiss` | solo se registra | dismissed |

`decidedBy` = `sub` del JWT.

## Tipos y severidad

| type | severidad | origen | sugerencias |
|---|---|---|---|
| `dropi_not_found` | critical | import (`estado` contiene `NO_ENCONTRADO`) | `swap_dropi_id` por candidato (id, nombre, coste, stock, proveedor, confianza, evidencia), `hide`, `keep` |
| `negative_margin` | critical si pierde en todos los escenarios (r=15% y r=30% / peor y mejor supuesto); high si solo en el peor | import y scan | `set_price` (import: PVP de equilibrio r=30%; scan: PVP mínimo con margen 10% en el peor supuesto, `financeContribution.minProfitablePrice`), `bundle_only`, `hide`, `keep` |
| `dropi_out_of_stock` | high | import (`stock` 0) y scan (`products.stock` 0 con ID Dropi) | `hide`, `keep` |
| `risky_category` | high | categoría/nombre de vapeo o adultos, o `RIESGO_CATEGORIA` | `hide`, `keep` |
| `unverified_claims` | high | scan: «solo quedan», «últimas unidades», urgencia sin dato de stock («cantidad limitada», «unidades limitadas», «antes de que se agoten/acaben», «la demanda sigue subiendo»…), «sin dolor», «protección UV/solar» sin la palabra «certific…» | `keep` (el texto se corrige editando la ficha), `hide` |
| `thin_margin` | medium | import: contribución r=30% < 1 USD o margen r=15% < 10%; scan: margen sobre neto < 10% en el peor supuesto | `set_price`, `bundle_only`, `keep` |
| `low_stock` | medium | stock 1–5 | `hide`, `keep` |
| `missing_dropi_id` | medium | sin `dropiProductId`/`externalId` de Dropi (no aplica a `effi`) | `hide`, `keep` |
| `missing_cost` | medium (import) / low (scan: falta `costPrice` en la ficha) | | `keep` |
| `missing_freight` | low | import: `fuente_flete` ESTIMADO | `keep` |

Supuestos del scan (constantes en el servicio): flete 5.10–7.96, vuelta = ida, rechazo 15–30 %, comisión de recaudo 3 %,
IVA del coste desconocido (se calculan ambos). Un producto pesado queda corto; el import con flete real manda.

## Reglas de persistencia

- Un issue abierto por `(product_id, type)`: índice único parcial `WHERE status = 'open'` + `INSERT … ON CONFLICT … DO UPDATE`.
  Seguro con scans concurrentes. Solo cuenta como `updated` si cambian detalles, sugerencias, severidad u origen: un scan repetido devuelve `{0,0,0}`.
- **Scan** recorre productos visibles (`show_shop` y no borrados). Resuelve (`status='resolved'`) sus issues abiertos que ya no se detectan
  (incluido el producto que se ocultó). **No pisa ni resuelve** un issue que vino del import (tiene datos reales).
- **Import** sustituye issues de scan y resuelve solo issues de import de los productos incluidos. Omite filas cuyo producto no existe
  o cuyo `dropi_id` no coincide con el actual (análisis desactualizado, p. ej. tras un swap).
- **No reabrir lo decidido**: cada issue lleva una `fingerprint` del problema (p. ej. `m:PVP|coste`, `dropi:ID`, `s:low`, `claims:…`).
  Si el último issue cerrado por decisión del mismo `(producto, tipo)` tiene la misma huella, no se vuelve a abrir. Si el problema cambia (otro PVP, otro texto), sí.
- Candidatos para `dropi_not_found`: columna `alternativas` de la fila (texto `id:nombre:coste:stock;…` o array de objetos), o si falta,
  búsqueda por nombre en el catálogo de Dropi (solo lectura; con `DROPI_MOCK=true` o sin token devuelve vacío). Nunca se aplican solos.
- Sin paginación (decenas de productos). Sin datos de clientes.

## Migración

`20261020000001-create-catalog-issues.js`: ADITIVA (`CREATE TABLE IF NOT EXISTS`), FK a `products` con `ON DELETE CASCADE`,
CHECK en `severity`, `source` y `status` (el `type` se valida en la aplicación para poder añadir tipos sin migración).
Down: `DROP TABLE IF EXISTS "catalog_issues"` (ninguna tabla la referencia).

## Seed local

```bash
node scripts/catalog-health-seed.js margenes.csv [--equivalencias equivalencias-dropi.csv] [--scan] [--dry-run]
```
Mismo flujo que `POST /import` (misma validación). `--equivalencias` añade como `alternativas` los candidatos verificados
(`product_id,dropi_id_antiguo,nombre_tienda,candidato_id,candidato_nombre,coste,stock,proveedor,foto_url,confianza,evidencia`),
ordenados por confianza. `--dry-run` no usa BD. Aborta si el host de `DATABASE_URL` parece producción.

## Tests

```bash
node scripts/catalog-health-test.js                                   # parte A: sin BD ni red
CATALOG_TEST_DATABASE_URL=postgres://… node scripts/catalog-health-test.js   # + parte B en schema temporal (staging/local)
# opcional, casos reales: CATALOG_HEALTH_CSV=margenes.csv CATALOG_HEALTH_EQUIV=equivalencias-dropi.csv CATALOG_HEALTH_PRODUCTS_JSON=products.json
```

## Decisión

Por qué una tabla de issues y no flags en `products`: el registro de decisiones es histórico (varias por producto y tipo) y no debe
ensuciar el modelo de producto ni la API pública. Descartado: aplicar automáticamente precios o swaps (el propietario decide);
consultar Dropi en cada scan (lento y frágil; la existencia en Dropi llega por el import del análisis).
