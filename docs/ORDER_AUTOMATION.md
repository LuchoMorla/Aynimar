# Automatización de pedidos hacia Dropi

Estado: **APAGADA por defecto**. Ningún pedido real llega a Dropi sin que el propietario lo autorice expresamente.
Código: `Services/orderAutomationService.js`, `Services/orderService.js` (`_dispatchOrder`), `integrations/dropi/dropiAdapter.js`, `workers/dropiRetryWorker.js`, `routes/orderExceptionsRouter.js`.
Migración: `db/migrations/20261020000002-order-automation.js` (aditiva y reversible). Tests: `scripts/order-automation-test.js`.

## 1. Interruptor y transporte

| Variable | Valores | Por defecto | Efecto |
|---|---|---|---|
| `DROPI_ORDER_AUTOMATION` | `off` / `supervised` / `auto` | `off` (un valor inválido también cuenta como `off`) | `off`: la orden confirmada queda en `AUTOMATION_OFF` y no se envía nada. `supervised`: cada pedido se confirma con un botón firmado de Telegram. `auto`: confirmación solo para los primeros `DROPI_ORDER_SUPERVISED_MIN` pedidos reales. |
| `DROPI_ORDER_SUPERVISED_MIN` | entero | 20 | Pedidos reales supervisados antes de pasar a automático (CEO-003). |
| `DROPI_ORDER_TRANSPORT` | `mock` / `http` | `mock` | `mock` no sale a la red y devuelve ids `MOCK-DRP-*`. **En producción, un pedido real con transporte mock se bloquea** (excepción `provider_error`), para que nunca quede "enviado" con un id simulado. `DROPI_MOCK=true` fuerza `mock`. |
| `DROPI_ORDER_API_URL` / `DROPI_ORDER_TOKEN` | — | sin definir | Solo para `http`. **El endpoint REST de órdenes NO está verificado**: Dropi no documenta uno para Ecuador. No se activa sin confirmación escrita de Dropi y autorización del propietario. |

El transporte `http` solo funciona en producción. Fuera de producción, un pedido real queda `BLOCKED`, y uno de prueba (`is_test`), `TEST_NOT_SENT`.

## 2. Validación previa (bloquea y abre una excepción; nunca sustituye productos ni precios)

| Comprobación | Excepción |
|---|---|
| Producto sin id Dropi numérico o componente de kit sin id | `missing_dropi_id` |
| Variante no elegida (ya **no** se toma la primera), inexistente o no numérica | `variant_mismatch` |
| Producto eliminado; issue `dropi_out_of_stock` en Salud del catálogo | `out_of_stock` |
| Nombre, apellido, dirección, teléfono EC o ciudad Dropi verificada ausentes | `incomplete_address` |
| Coste desconocido o contribución por debajo del piso | `margin_insufficient` |
| Cantidad fuera de rango, pedido sin líneas, importe COD distinto de las líneas, pago no despachable | `inconsistent_data` |
| Mismo cliente y mismas líneas en `ORDER_DUPLICATE_WINDOW_HOURS` (24 h) | `possible_duplicate` |
| Issues abiertos de Salud del catálogo (`dropi_not_found`, `missing_dropi_id`, `dropi_out_of_stock`, `negative_margin`, `missing_cost`) | según el tipo |
| Orden cancelada | `CANCELLED`, sin envío |

Si la tabla `catalog_issues` (rama `feat/catalog-health`) aún no existe, se omite solo esa fuente y el resto de comprobaciones sigue aplicando.

**Pisos de margen**, calculados al `ORDER_MARGIN_REJECT_RATE` (0,30) de rechazo, con flete, devolución y comisión COD en el peor caso del rango:
- Piloto supervisado (`pilotFloor`): contribución ≥ `ORDER_PILOT_MIN_CONTRIBUTION_USD` (1,00), según la decisión del propietario de 04:10.
- Automático (`autoFloor`): ≥ `ORDER_AUTO_MIN_CONTRIBUTION_USD` (5) y ≥ `ORDER_AUTO_MIN_MARGIN_ON_NET` (15 %) de la venta neta. Es la propuesta de CEO-003 y está PROVISIONAL.

Ciudades: el backend no puede llamar a `search_cities`, que solo existe en el MCP. Por eso se parte de una lista verificada (QUITO 802 y GUAYAQUIL 732) más la tabla `app_settings.dropi_cities`, que crece cuando un operador resuelve una excepción `incomplete_address` con `dropiCity`.

## 3. Outbox e idempotencia

- Clave: `shop_order_id = AYNIMAR-<id>`, que se envía a Dropi y permite buscar el pedido con `list_orders`.
- Claim atómico: `UPDATE … SET fulfillment_status='SENDING', dispatch_started_at=now()` con la condición `fulfillment_retry_count`, `dropi_order_id IS NULL`, un estado pendiente y una orden no cancelada. Si dos procesos lo intentan a la vez, solo uno lo consigue.
- **Error ambiguo** (timeout, error de red, 5xx o 2xx sin id): pasa a `DISPATCH_UNKNOWN` con la excepción `dispatch_unknown`. Nadie reintenta: ni el worker, ni `_dispatchOrder`, ni `/retry-fulfillment` (este devuelve 409). Una persona busca `AYNIMAR-<id>` en Dropi y resuelve con `link` (lo encontró) o `not_created` (no existe, y entonces se envía una sola vez).
- `SENDING` colgado más de `ORDER_SENDING_TIMEOUT_MIN` (10 min), porque el proceso murió: lo mismo que un error ambiguo.
- **Error definitivo** (4xx o transporte sin configurar): se reintenta hasta `MAX_DISPATCH_ATTEMPTS`, después pasa a `FAILED_DROPI_FULFILLMENT` con la excepción `provider_error` y un aviso por Telegram.

## 4. Estados de Dropi y conciliación contra entrega

Dropi no ofrece webhooks, así que el worker consulta cada 30 min (solo con la automatización encendida). Los estados vienen de la lista real de `list_statuses`:

| Grupo de Dropi | `state_order` |
|---|---|
| preparación | `en_preparacion` |
| tránsito | `en_transito` |
| entregado | `entregado` |
| devolución en curso | `por_devolver` |
| devuelto | `devuelto` |
| rechazado / cancelado | `cancelado` |

Reglas:
- Nunca se retrocede de estado. Pasar de un estado terminal a otro abre `unknown_status`.
- Una novedad abre `delivery_issue`, y un estado desconocido, `unknown_status`.
- Contra entrega:
  - entregado → `cod_status=pending_settlement` y excepción `cod_unreconciled`. **No** se marca como cobrado hasta conciliar.
  - rechazado, devuelto o cancelado → `not_collected` con `payment_status=failed`.
  - `collected` solo se acepta para un pedido entregado y pendiente de liquidación: un rechazado devuelve 409.
- Cancelación (`PATCH` con `stateOrder=cancelado`):
  - Antes del envío: `CANCELLED`. Tampoco envía un botón «Enviar» que llegue tarde.
  - Después del envío: excepción `cancelled_after_dispatch` y aviso para anularla en Dropi.
  - En los dos casos, el contra entrega queda `not_collected`.

## 5. API de excepciones (JWT y rol admin)

- `GET /api/v1/order-exceptions?status=open|resolved|all&type=&limit=`: devuelve `{ items, count, mode }`, sin datos personales.
- `POST /api/v1/order-exceptions/:id/resolve` con el cuerpo `{ resolution, note?, dropiOrderId?, amount?, shippingCost?, providerFees?, dropiCity? }`.
  - Resoluciones: `retry`, `accept`, `manual`, `link`, `not_created`, `collected`, `not_collected`. La tabla `RESOLUTIONS` del servicio indica cuáles admite cada tipo.
  - El cierre es atómico: si dos personas resuelven a la vez, la segunda recibe 409.

## 6. Activación (requiere autorización del propietario en cada paso)

1. Staging con `DROPI_ORDER_AUTOMATION=supervised` y transporte mock: pedidos sintéticos.
2. Confirmar con Dropi por escrito el transporte de órdenes (endpoint y credencial) o usar su integración de tienda.
3. Piloto: producción, `supervised`, `http`, 20 pedidos liberados uno a uno (CEO-003).
4. `auto` con un tope diario. Ese tope aún no está implementado: hay que hacerlo antes de este paso.
