# Release Candidate — Fase A + Fase B + Pricing Engine + DeUna

Rama: `feat/fase-b-cod-dropi` · Tag RC: `rc/fase-a-b` · Base: `origin/main`

Este documento es el runbook de despliegue a **producción**. Al momento de
escribirlo, todo está validado en **staging** y **producción NO ha sido tocada**.

---

## 1. Qué entra en este release (20 commits sobre `main`)

- **Fase A (seguridad + estabilización de pagos):** `payment_status` ENUM separado
  del estado de orden, CORS whitelist, autorización en mutación de carrito,
  `validatorHandler` corta la request, bloqueo de despacho MOCK en producción (Effi),
  totales de orden persistidos, cierre de escalada de estado + `confirm-cod` controlado.
- **Fase B (COD → Dropi seguro y consistente):** `_finalizeAndDispatch` (transacción
  con lock de fila + transición atómica + stock con guard + totales), despacho
  idempotente con claim atómico (`fulfillmentRetryCount`), recuperación tras muerte
  de proceso (`dropiRetryWorker`), créditos parciales + COD, lock solo de la fila
  `orders` (evita el bug FOR UPDATE + outer join).
- **Pricing Engine + DeUna/Transferencia (Paso 11):** motor de precios
  (manual > engine > legacy_sync), `PaymentProof` (subida validada → revisión admin
  → approve/reject), QR/link estático DeUna.
- **IVA — RESUELTO:** RIMPE Emprendedor, 15%, `product.price` = PVP con IVA incluido
  (`Services/orderTotals.js`, única fuente). Ver `docs/PAYMENTS.md §3`.
- **Reparación de la cadena de migraciones:** reproducible y determinista desde una
  BD PostgreSQL nueva (ver §3).

---

## 2. Migraciones que producción ejecutará

`origin/main` tiene **46** migraciones aplicadas; este release añade **11**. El
`prestart` (`sequelize db:migrate`) las corre automáticamente en el deploy.

| # | Migración | Efecto | Riesgo |
|---|---|---|---|
| 1 | `20260905000001-add-payment-status-to-orders` | `ADD COLUMN payment_status` ENUM `NOT NULL DEFAULT 'pending'` + backfill: `paid` sólo con evidencia (`state='pagada'` o créditos 100%); normaliza `payment_method='cod'` en COD histórico | Bajo — additiva + default; backfill sólo toca filas de estado legado |
| 2 | `20260905000002-persist-order-totals` | `ADD COLUMN subtotal, tax` DECIMAL(10,2) `NOT NULL DEFAULT 0`. SIN backfill (histórico queda en 0 = "no registrado") | Muy bajo — additiva |
| 3 | `20260906000001-add-unit-price-gross-to-orders-products` | `ADD COLUMN unit_price_gross` | Muy bajo — additiva |
| 4 | `20260906000002-add-unit-cost-snapshot-to-orders-products` | `ADD COLUMN unit_cost_snapshot` | Muy bajo — additiva |
| 5 | `20260906000003-add-pricing-source-to-products` | `ADD COLUMN pricing_source` (ENUM) + `pricing_cost_snapshot`, `pricing_calculated_price`, `pricing_applied_at` | Bajo — additivas, defaults |
| 6 | `20260906000004-create-payment-proofs` | `CREATE TABLE payment_proofs` (+ índices, FK a `orders`/`users`) | Muy bajo — tabla nueva |
| 7 | `20260907000001-allow-null-customer-id-on-orders` | `orders.customer_id` NOT NULL → nullable | Bajo — no afecta filas existentes (todas tienen customer_id). Genera transitoriamente una FK duplicada que la #10 elimina |
| 8 | `20260907000002-allow-null-payment-method-on-orders` | `orders.payment_method` NOT NULL → nullable (mantiene default `contra_entrega`) | Bajo |
| 9 | `20260907000003-fix-customer-identity-number-type` | `customers.identity_number` `integer` → `varchar(255)` (`USING ::varchar`) | Bajo — conversión int→varchar siempre lossless para valores que ya caben en int32. **Verificar** (§4) que prod no tenga NULLs inesperados |
| 10 | `20260907000004-fix-customer-id-nullable-duplicate-fk` | Elimina la FK duplicada `orders_customer_id_fkey1` creada por #7 y re-aplica la nulabilidad sin `references` | Bajo — `removeConstraint` en try/catch |
| 11 | `20260907000005-drop-duplicate-business-owner-fk` | `ALTER TABLE business DROP CONSTRAINT IF EXISTS business_business_owner_id_fkey1` (FK duplicada histórica) | Nulo — `IF EXISTS`; la FK legítima no se toca |

**Las 8 migraciones históricas editadas** (`debitCard`, `debitM`, `create-business-owner`,
`create-business-model`, `add-keys`, `update-waste-payment`, `update-2`,
`update_order-product`) **NO se re-ejecutan** en producción: `sequelize-cli` rastrea
por nombre de archivo en `SequelizeMeta`, y esas migraciones (2023–2025) ya están
registradas. Editarlas sólo cambia lo que produce una BD **nueva** desde cero.

### Seguridad e idempotencia (validado)
- Cadena completa de 57 migraciones corrida **4×** desde una BD PostgreSQL vacía
  (PGlite = PostgreSQL 18): **exit 0**, segunda corrida "No migrations were executed".
- Esquema resultante **byte-idéntico** al de staging (PostgreSQL 16.15) salvo
  `app_settings` (la crea la app al boot, no una migración) y la FK duplicada que
  elimina la #11.
- La #11 ya se aplicó en **staging (PG16 real)**: `SequelizeMeta` = 57, FK duplicada
  eliminada, sin incidencias.

---

## 3. Pre-requisitos y variables de entorno (Railway → producción)

**Ya configuradas y suficientes** (el servicio arranca y opera):
`DATABASE_URL`, `JWT_SECRET`, `TEMPORALY_JWT_SECRET`, `NODE_ENV=production`,
`DROPI_ORDER_TOKEN` (o `WOO_CONSUMER_SECRET`), `DROPI_WORKER_URL`, `DROPI_WORKER_KEY`,
`RESEND_API_KEY`/`GPASS`, `TELEGRAM_BOT_TOKEN` (alertas de fallo de despacho).

**Nuevas / a revisar para este release:**
| Var | Requerida | Default | Notas |
|---|---|---|---|
| `DEUNA_PAYMENT_LINK` | No | link en código (cuenta ****5005) | Setear sólo si el negocio rota el link de cobro DeUna |
| `EFFI_ALLOW_MOCK` | No | `false` (implícito) | Dejar SIN setear: en prod, Effi en MOCK **lanza** (A6). Si hay productos Effi que despachar, setear `EFFI_API_KEY` real |
| `EFFI_API_KEY` | Sólo si se usan productos Effi | — | Sin esto, órdenes con ítems Effi → `PENDING_DROPI_FULFILLMENT` + alerta |
| `GROQ_API_KEY` | No | — | Sin esto `/health` = `degraded` (inocuo); sólo afecta generación de copy IA |

**NO poner en Railway:** `WOO_CONSUMER_KEY`/`SECRET` por negocio → van en la tabla
`business` (Dashboard → Business → Settings).

---

## 4. Procedimiento de deploy a producción

> Requiere autorización explícita. Producción = entorno Railway `production`,
> proyecto `BAynimar`, servicio `Aynimar` (rama `main`).

1. **(Recomendado) Backup de la BD de producción** — snapshot del volumen de
   Postgres en Railway, o `pg_dump` a un archivo seguro. Es la red de seguridad
   real ante cualquier sorpresa de los backfills (#1, #9).
2. **Verificación read-only previa** (opcional, 2 min) contra la BD de producción:
   ```sql
   SELECT count(*) FROM "SequelizeMeta";                       -- esperado: 46
   SELECT count(*) FROM customers WHERE identity_number IS NULL; -- filas que la #9 dejará como NULL (ok)
   SELECT data_type FROM information_schema.columns
     WHERE table_name='customers' AND column_name='identity_number'; -- esperado: integer
   SELECT count(*) FROM orders WHERE state='pagada';           -- filas que la #1 marcará payment_status='paid'
   ```
3. **Merge** `feat/fase-b-cod-dropi` → `main` (PR o fast-forward). No hacer squash
   si se quiere conservar el historial de Fase A/B.
4. **Deploy**: Railway despliega `main` automáticamente al hacer push. El `prestart`
   corre `sequelize db:migrate` (las 11 migraciones) **antes** de arrancar el server.
5. **Watch del deploy log** en Railway: confirmar que las 11 migraciones muestran
   `migrated (Xs)` y que aparece `[OK] Server listening`. Si una migración falla, el
   `|| echo` del `prestart` deja arrancar el server igual — **no ignorar**: revisar
   el log, corregir, redeploy.
6. **Post-deploy smoke** (2 min):
   ```
   curl -s https://<prod-domain>/health            # 200, jwt_secret:true
   curl -s https://<prod-domain>/api/v1/orders/track/1   # 404, NUNCA 500 "column ... does not exist"
   ```
   Y en la BD: `SELECT count(*) FROM "SequelizeMeta";` → **57**.
7. **Smoke funcional** (recomendado): una compra COD real de bajo valor de punta a
   punta y verificar `state='pendiente_envio'`, `payment_status='pending'`,
   `fulfillment_status` (`DISPATCHED` si hay token Dropi, o `PENDING_DROPI_FULFILLMENT`
   + alerta Telegram si no).

---

## 5. Rollback

Las 11 migraciones son **aditivas o de relajación de constraints** — el código
anterior tolera que las columnas nuevas existan (no las lee; `payment_status` es
`NOT NULL DEFAULT`, `customer_id` nullable no rompe inserts que siempre lo setean).

**Rollback de código (rápido, sin tocar esquema):**
- Railway → servicio `Aynimar` → Deployments → *Redeploy* del deployment anterior
  (o `git revert` del merge y push). El esquema nuevo queda en su lugar, inerte.
  Es el rollback recomendado.

**Rollback de esquema (sólo si es imprescindible):**
- Las 10 migraciones de datos/columnas tienen `down()` real:
  `npm run migrations:revert` (una a una, en orden inverso) o
  `npx sequelize-cli db:migrate:undo --to 20260905000001-add-payment-status-to-orders.js`.
- `20260907000005` tiene `down()` no-op **a propósito** (no recrea una FK duplicada).
- ⚠️ El `down()` de la cadena **histórica** (pre-2026-09) está roto en varias
  migraciones — **no** correr `db:migrate:undo:all`. Revertir sólo las 10 nuevas.
- Antes de revertir #1 (`payment_status`): `DROP TYPE` del ENUM sólo aplica si no
  quedó ninguna columna dependiente (la migración lo maneja con `IF EXISTS`).

**Datos:** ningún backfill destruye información. #1 escribe `payment_status`
derivándolo del estado legado; #9 convierte int→texto (lossless). El backup del
paso 4.1 cubre cualquier caso no previsto.

---

## 6. Riesgos residuales / dependencias externas

- **B1 — monto COD a Dropi**: `dispatchToProviders` NO envía `codAmount` a Dropi.
  Bloqueado por falta de doc/panel de Dropi (nombre de campo, nivel, IVA/flete,
  comportamiento al omitir). NO es un bug de código. Activación de 1 línea cuando
  se confirme. Ver `docs/PAYMENTS.md §4`. **Impacto en prod:** el repartidor de
  Dropi no recibe automáticamente el monto a cobrar en COD — hoy se gestiona
  fuera del sistema (igual que antes de este release).
- **Reconciliación Dropi por timeout**: si Dropi crea la orden pero se pierde la
  respuesta HTTP → hasta `MAX_DISPATCH_ATTEMPTS` reintentos → `FAILED_DROPI_FULFILLMENT`
  + alerta Telegram para reconciliación manual. Se cierra del todo sólo si Dropi
  expone consulta por `referencia` (`AYNIMAR-<id>`).
- **DeUna aprobar→paid→despacho por HTTP end-to-end** no se probó contra staging
  desplegado porque requiere subir un archivo real a Firebase Storage
  (`payment-proofs/<orderId>/`). Cubierto por `scripts/smoke-test.js` (suite DeUna
  + sección PaymentProof, ~35 aserciones) y por la validación estructural del E2E
  (rechazo de URL inválida/externa/de otra orden/no autorizada).
- **`db:migrate:undo:all` roto** en la cadena histórica (deuda pre-existente,
  documentada en `docs/PAYMENTS.md`). No afecta el deploy forward.
- **`identity_number` con ceros a la izquierda**: cédulas guardadas como integer
  ya perdieron los ceros ANTES de este release; la #9 no los recupera (ni los
  puede) — sólo evita que el problema siga creciendo.

---

## 7. Estado de validación (al preparar este RC)

| Check | Resultado |
|---|---|
| Cadena de migraciones desde BD nueva (×4) | 57/57, exit 0, 2ª corrida limpia |
| Diff esquema BD nueva vs staging PG16 | idéntico (salvo `app_settings` + FK dup que elimina #11) |
| `npm test` (smoke) | 710/710 |
| `verify-checkout-pg-lock.js` | 18/18 |
| E2E HTTP contra staging desplegado | 49/49 |
| eslint (archivos tocados) | 0 errores |
| Staging desplegado | `9ab40e9`, `/health` 200, `SequelizeMeta`=57 |
