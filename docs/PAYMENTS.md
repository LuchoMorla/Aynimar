# Modelo de pagos y órdenes — Aynimar

Estado: **MVP de cierre** (Fase A + B aplicadas en ramas, sin merge).

---

## 1. Campos de estado de una orden (`orders`)

| Campo | Tipo | Para qué |
|---|---|---|
| `state` | STRING (legado) | `carrito` → `comprada` / `pendiente_envio`. A deprecar; se mantiene por compatibilidad con consultas existentes. |
| `state_order` | ENUM | **Fulfillment**: `comprado_pendiente_pago`, `comprado_pendiente_negocio`, `aprobado`, `en_preparacion`, `necesita_edicion`, `enviado`, `entregado`, `en_transito`, `cancelado`, `por_devolver`, `devuelto`, `error_api_proveedor`, `en_controversia`, `controversia_escalada`, `controversia_resuelta`. |
| `payment_status` | ENUM | **Pago** (Fase A): `pending`, `pending_verification`, `paid`, `failed`, `refunded`. Única fuente de verdad del pago. |
| `payment_method` | STRING | `cod`, `green_credits`, `credits_partial`, (histórico: `contra_entrega`, `tarjeta`, null). |
| `fulfillment_status` | STRING | `PENDING_DISPATCH`, `DISPATCHED`, `MANUAL_LOGISTICS`, `PENDING_DROPI_FULFILLMENT`, `FAILED_DROPI_FULFILLMENT`. |
| `subtotal` / `tax` / `total` | DECIMAL(10,2) | Persistidos al confirmar la orden (Fase A/B). El frontend sólo los MUESTRA, nunca los calcula. |

### Máquina de estados (resumen)

```
carrito ──confirm-cod / checkout(créditos)──► comprada|pendiente_envio  (payment_status: pending|paid)
                                                     │
                                          _dispatchOrder()
                                          ├─ éxito ──► state_order=en_preparacion, fulfillment=DISPATCHED, dropi_order_id
                                          ├─ sin ítems Dropi ──► fulfillment=MANUAL_LOGISTICS
                                          └─ fallo ──► state_order=error_api_proveedor, fulfillment=PENDING_DROPI_FULFILLMENT
                                                         │  dropiRetryWorker (cada 5 min, máx 3)
                                                         └─ 3 fallos ──► FAILED_DROPI_FULFILLMENT + alerta Telegram
```

Estados terminales de `state_order` (sólo un `admin` los revierte): `entregado`, `cancelado`, `devuelto`, `controversia_resuelta`.

---

## 2. Métodos de pago del MVP

| Método | Estado | Notas |
|---|---|---|
| **Contra Entrega (COD)** | Operativo | `POST /orders/:id/confirm-cod`. `payment_status='pending'` (se cobra al entregar). Dispara despacho. |
| **Ayni-Créditos** | Operativo | `POST /orders/checkout`. Cubre 100% → `payment_status='paid'`. Parcial → resto por COD. |
| **DeUna / Transferencia + comprobante** | Operativo (Fase B, Paso 11) | Una sola opción visible en el checkout. Cliente paga por DeUna **o** transferencia/depósito a la misma cuenta y sube el comprobante. `GET /orders/:id/payment/deuna` (link/monto, solo lectura) → `POST /orders/:id/payment-proof` (evidencia, NUNCA confirma) → `payment_status='pending_verification'` → un admin/`business_owner` hace `approve` (→ `paid` + despacho, mismo `_finalizeAndDispatch` que COD) o `reject` (→ `failed`, permite re-subir). QR/link estático `pagar.deuna.app/H92p/merchant?id=…` (cuenta ****5005) — no es API, verificación 100% manual. |
| Tarjeta (Paymentez/Nuvei) | Oculto / fase futura | Código en `frontAynimar/src/common/paymentez/`, sin referencias. |
| Cupón de descuento | Oculto / Fase C | Se valida en `POST /coupons/validate` pero **NO se aplica** a la orden en el backend. Oculto del checkout en el MVP para no mostrar un descuento que no se cobra. |

---

## 3. IVA — RESUELTO (2026-09-06) ✅

**Decisión de negocio tomada.** Aynimar S.A.S. está en el régimen **RIMPE Emprendedor**
del SRI → **sí cobra IVA**, a la tarifa general vigente **15%**.

**Convención única de todo el sistema:**

> `product.price` = **PVP final que paga el cliente, IVA INCLUIDO.**

- El IVA **nunca** se suma hacia adelante (nunca `precio × 1.15`) — ya está contenido en el precio.
- Se extrae hacia atrás sólo para el desglose informativo/tributario:
  `base_imponible = PVP / 1.15`, `tax = PVP − base_imponible`.
- `tax` es **informativo**; no es utilidad ni se resta del monto a cobrar.
- Créditos/descuentos se restan directo del `subtotal` (ya con IVA); no se recalcula impuesto sobre el saldo.

**Implementación (única fuente de verdad):** `Services/orderTotals.js`
— `TAX_RATE = 0.15`, `computeOrderTotals()`. Es el ÚNICO archivo del backend que conoce `TAX_RATE`.
`checkout()` y `_finalizeAndDispatch()` la consumen; nadie más reimplementa la fórmula.
El Pricing Engine (`Services/pricingEngine.js`) usa `toGross`/`extractFromGross` del mismo archivo.

**Frontend alineado:** `checkout.js` y `WalletRedeem.jsx` muestran "Subtotal (IVA incluido)"
y el `order.total` del backend — ya NO hay línea "+ IVA 15%" ni multiplicación `× 1.15`.

**Cobertura:** `scripts/smoke-test.js` §6 (TAX_RATE, extracción hacia atrás, `base + tax === subtotal`
exacto, créditos sin doble-IVA, ejemplo de referencia) — verde. E2E staging confirma
`tax` en BD = IVA contenido para órdenes COD y checkout.

---

## 4. COD → Dropi — monto a cobrar (B1) — DEPENDENCIA EXTERNA ⚠️

**Estado: bloqueado por falta de documentación / acceso al panel de Dropi. NO es un bug de código de Aynimar** — es una integración que no se puede completar de forma responsable sin confirmar el contrato del proveedor.

`integrations/dropi/dropiAdapter.js` (`createOrderInDropi`) ya tiene el plumbing:
`payload.codAmount` → `body.valor_a_cobrar` (orden) y `item.codAmount` → `p.valor_cobrar` (producto).
Pero **son nombres de campo especulativos, sin fuente oficial**, y hoy `dispatchToProviders`
**no pasa `codAmount`** → Dropi recibe la orden COD sin monto a recaudar.

Lo que ya está resuelto de nuestro lado:
- El monto a cobrar es `order.total` (server-side, `Services/orderTotals.js`, IVA ya incluido — ver §3).
- El despacho es idempotente y con reconciliación manual (§5).

Lo que **falta confirmar con Dropi** antes de activar el envío del monto (no se puede inventar):
1. Nombre exacto del campo del monto a recaudar en COD (¿`valor_a_cobrar`? ¿otro?).
2. Nivel: **por orden** (total) o **por producto** (unitario/línea).
3. Si el valor esperado **incluye IVA** y/o **el flete**.
4. Qué hace Dropi si el campo **se omite** (¿cobra su PVP de catálogo? ¿$0? ¿rechaza la orden?).
5. Si existe endpoint para **consultar una orden por `referencia`** (`AYNIMAR-<id>`) → cerraría del todo el riesgo residual de §5.
6. Que el response de creación devuelve efectivamente `id_orden` / `id`.

**Activación (1 línea, cuando Dropi confirme):** en `OrderService.dispatchToProviders`, al construir
`byProvider.dropi` para una orden con `paymentMethod === 'cod'` (o `payment_status !== 'paid'`),
pasar `codAmount: order.total` a `createOrderInDropi(...)` en el campo/nivel confirmado, y añadir
el test correspondiente. Hasta entonces queda deshabilitado a propósito.

---

## 5. Idempotencia y consistencia del despacho (Fase B — B3/B4)

- **Confirmación de orden** (`_finalizeAndDispatch`): transacción DB con `LOCK.UPDATE` sobre la orden. Dos peticiones concurrentes de `confirm-cod` → la 2ª bloquea en el lock, luego ve `state != 'carrito'` → **409**. Un solo despacho.
- **Descuento de stock**: dentro de la transacción, con re-lectura de `Product` con `LOCK.UPDATE` y guard `stock >= qty` (no puede quedar negativo; cierra la ventana TOCTOU).
- **Llamada externa a Dropi/Effi**: SIEMPRE fuera de la transacción, después del commit.
- **Guard `dropiOrderId`**: `dispatchToProviders`, `_dispatchOrder` y `retryFulfillment` no vuelven a crear una orden en Dropi si `order.dropiOrderId` ya está seteado.
- **Riesgo residual**: si Dropi crea la orden pero la respuesta HTTP se pierde (timeout), no tenemos el `id_orden` → el worker reintenta → posible 2ª orden en Dropi. Mitigado por `MAX_RETRIES=3` + `FAILED_DROPI_FULFILLMENT` + alerta Telegram para reconciliación manual. Se elimina del todo sólo si Dropi permite consultar por `referencia` (ver §4.6).
