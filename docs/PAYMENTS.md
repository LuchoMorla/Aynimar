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
| Transferencia / Depósito + comprobante | Fase C | — |
| Deuna + comprobante | Fase C | QR/link estático `pagar.deuna.app/H92p/merchant?id=…` (cuenta ****5005). No es API. |
| Tarjeta (Paymentez/Nuvei) | Oculto / fase futura | Código en `frontAynimar/src/common/paymentez/`, sin referencias. |
| Cupón de descuento | Oculto / Fase C | Se valida en `POST /coupons/validate` pero **NO se aplica** a la orden en el backend. Oculto del checkout en el MVP para no mostrar un descuento que no se cobra. |

---

## 3. IVA — DECISIÓN DE NEGOCIO PENDIENTE ⚠️

**No resuelto.** El proyecto es contradictorio:

- El **dashboard** llama a `products.price` **"PVP / Precio de Venta"** (convención Ecuador ⇒ **IVA incluido**). El cálculo de margen `(pvp − costoDropi) / pvp` trata el PVP como precio final.
- El **checkout de la tienda** trata `price` como **sin IVA** (`valorTotalSinIva`, "Cart total without IVA") y muestra una línea **"+ IVA 15%"** (`× 1.15`).

**Hasta que negocio confirme cómo se fijan los precios**, el backend NO separa IVA:
`_computeOrderTotals` (`Services/orderService.js`) devuelve `tax = 0`, `total = subtotal`.
Es el **único** lugar del backend donde vive la fórmula.

**Para cerrar esto se necesita responder:**
1. ¿El precio publicado es PVP con IVA incluido, o pre-IVA?
2. ¿Aynimar factura/remite IVA? ¿Régimen RIMPE (sin IVA) u otro?
3. ¿Los precios de catálogo de Dropi son con o sin IVA?

Cuando se resuelva: ajustar SÓLO `_computeOrderTotals` y alinear el display de la tienda (`checkout.js`, `WalletRedeem.jsx`) para que muestre `order.total`.

---

## 4. COD → Dropi — `valor_a_cobrar` PENDIENTE ⚠️ (B1)

`integrations/dropi/dropiAdapter.js` (`createOrderInDropi`) tiene DOS campos escritos
**especulativamente**, sin fuente:

- `productos[n].valor_cobrar` — nivel producto
- `body.valor_a_cobrar` — nivel orden

Hoy **ninguno se envía** (`codAmount` siempre `undefined`) → Dropi recibe la orden COD sin monto a cobrar.

**No implementar hasta confirmar con Dropi (panel o doc de API):**

1. Qué campo corresponde al monto a recaudar en COD.
2. Si es **por producto** (unitario / línea) o **por orden** (total).
3. Si **incluye IVA**.
4. Si **incluye el envío/flete**.
5. Qué hace Dropi cuando el campo **se omite** (¿cobra su PVP de catálogo? ¿$0? ¿rechaza?).
6. Si existe un endpoint para **consultar/reconciliar una orden por `referencia`** (`AYNIMAR-<id>`) — necesario para la idempotencia del caso "Dropi creó la orden pero perdimos el `id_orden`".

También verificar que el response de `POST /api/v1/orders` realmente devuelve `id_orden` / `id`.

Cuando se confirme: pasar `codAmount = order.total` (valor server-side de `_computeOrderTotals`, ya con la decisión de IVA tomada) al campo correcto en `dispatchToProviders`.

---

## 5. Idempotencia y consistencia del despacho (Fase B — B3/B4)

- **Confirmación de orden** (`_finalizeAndDispatch`): transacción DB con `LOCK.UPDATE` sobre la orden. Dos peticiones concurrentes de `confirm-cod` → la 2ª bloquea en el lock, luego ve `state != 'carrito'` → **409**. Un solo despacho.
- **Descuento de stock**: dentro de la transacción, con re-lectura de `Product` con `LOCK.UPDATE` y guard `stock >= qty` (no puede quedar negativo; cierra la ventana TOCTOU).
- **Llamada externa a Dropi/Effi**: SIEMPRE fuera de la transacción, después del commit.
- **Guard `dropiOrderId`**: `dispatchToProviders`, `_dispatchOrder` y `retryFulfillment` no vuelven a crear una orden en Dropi si `order.dropiOrderId` ya está seteado.
- **Riesgo residual**: si Dropi crea la orden pero la respuesta HTTP se pierde (timeout), no tenemos el `id_orden` → el worker reintenta → posible 2ª orden en Dropi. Mitigado por `MAX_RETRIES=3` + `FAILED_DROPI_FULFILLMENT` + alerta Telegram para reconciliación manual. Se elimina del todo sólo si Dropi permite consultar por `referencia` (ver §4.6).
