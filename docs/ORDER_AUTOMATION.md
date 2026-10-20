# Automatización de pedidos hacia Dropi

Estado: **APAGADA por defecto**. Ningún pedido real llega a Dropi sin que el propietario lo autorice expresamente.
Código: `Services/orderAutomationService.js`, `Services/orderService.js` (`_dispatchOrder`), `integrations/dropi/dropiAdapter.js`, `workers/dropiRetryWorker.js`, `routes/orderExceptionsRouter.js`.
Migración: `db/migrations/20261020000002-order-automation.js` (aditiva y reversible). Tests: `scripts/order-automation-test.js`.

## 1. Interruptor y transporte

| Variable | Valores | Por defecto | Efecto |
|---|---|---|---|
| `DROPI_ORDER_AUTOMATION` | `off` / `supervised` / `auto` | `off` (un valor inválido también cuenta como `off`) | `off`: la orden confirmada queda en `AUTOMATION_OFF` y no se envía nada. `supervised` (piloto = operador manual): cada pedido se confirma con un botón firmado de Telegram. `auto`: confirmación solo para los primeros `DROPI_ORDER_SUPERVISED_MIN` pedidos reales. |
| `DROPI_ORDER_AUTO_ENABLED` | `true` / otro | apagado | CEO-004: sin este flag, `auto` se comporta como `supervised`. |
| `ORDER_DAILY_DISPATCH_CAP` | entero | 5 | CEO-004: tope diario (día de Ecuador, UTC-5) de órdenes **reales** enviadas, en vuelo o con resultado desconocido. Al llegar al tope, el pedido queda `BLOCKED` con la excepción `daily_cap_reached` (en cola, no se descarta). Se resuelve con `retry` (vuelve a comprobar el tope) o `manual`. |
| `DROPI_ORDER_SUPERVISED_MIN` | entero | 20 | Pedidos reales supervisados antes de pasar a automático (CEO-003). |
| `DROPI_ORDER_TRANSPORT` | `mock` / `http` | `mock` | `mock` no sale a la red y devuelve ids `MOCK-DRP-*`. **En producción, un pedido real con transporte mock se bloquea** (excepción `provider_error`), para que nunca quede "enviado" con un id simulado. `DROPI_MOCK=true` fuerza `mock`. |
| `DROPI_ORDER_HTTP_ENABLED` | `true` / otro | apagado | CEO-004: flag explícito, además del token, para habilitar `http`. |
| `DROPI_INTEGRATION_KEY` | secreto | sin definir | Token de Dropi > Mis integraciones (integración WooCommerce). Va solo en la cabecera `dropi-integration-key`. Sin él, `http` queda DESHABILITADO. **Nunca** se usan `DROPI_ORDER_TOKEN` ni `WOO_CONSUMER_SECRET` como respaldo. |
| `DROPI_ORDER_API_HOST` | host | `api.dropi.ec` | Solo se admite `https://api.dropi.ec` (y `http://127.0.0.1:<puerto>` con `NODE_ENV=test`, para el servidor falso de los tests). Se rechaza cualquier host `.co`, cualquier ruta (p. ej. el antiguo `/api/v1/orders`) y la variable antigua `DROPI_ORDER_API_URL` si sigue definida. |
| `DROPI_ORDER_STATE_FORMAT` | `code` / `name` | `code` | Formato de `state` (SIN CONFIRMAR por Dropi): `code` = `EC-P`, lo que envía el plugin oficial; `name` = `PICHINCHA`. `city` va siempre en mayúsculas (`QUITO`). |
| `DROPI_ORDER_TIMEOUT_MS` | ms | 20000 | Pasado este tiempo, el envío queda como resultado desconocido. |

**Transporte oficial Ecuador** (copiado del plugin oficial `wc-dropi-integration` 4.7.3, `OrdersModel::save`):
- `POST https://api.dropi.ec/integrations/orders/myorders`, `Content-Type: application/json;charset=UTF-8`, `dropi-integration-key: <DROPI_INTEGRATION_KEY>`.
- Cuerpo: `total_order, notes (AYNIMAR-<id>), name, surname, dir, country:"EC", state, city, phone, client_email, payment_method_id:1, status:"PENDIENTE CONFIRMACION", type:"FINAL_ORDER", rate_type ("CON RECAUDO" en COD, "SIN RECAUDO" pagado), products[] {id, name, type SIMPLE|VARIABLE, user_id, quantity, price, variation_id si es VARIABLE}, calculate_costs_and_shiping:true, supplier_id, shop_order_id:"AYNIMAR-<id>", create_product_if_not_exist:false`. A diferencia del plugin, el token **no** va dentro de `products[]`.
- Respuesta: `isSuccess=false` → excepción `provider_error` con el `message` de Dropi y sin reintento automático. `objects.id` → se guarda como `dropi_order_id`. 2xx sin `objects.id`, 5xx, timeout o error de red → resultado desconocido.
- No hay consulta de estado ni de cancelación en esta API: el worker no obtiene estados en `http` (se revisan en el panel o con el MCP del operador).
- `supplier_id`: el `user_id` del proveedor en Dropi. Se toma de la tabla verificada `app_settings.dropi_suppliers` (`{"<id producto Dropi>": <user_id>}`). Con `http`, un producto sin proveedor verificado bloquea con `missing_dropi_id`, y un pedido con varios proveedores, con `inconsistent_data`.
- Arranque: `index.js` registra `http RECHAZADO` y el motivo si el host, el flag o el token no son válidos. Cada pedido se bloquea en `preDispatch` con esa misma razón (`provider_error`), antes del claim y sin llamar a Dropi.

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
| Proveedor Dropi (`supplier_id`) sin verificar, solo con `http` | `missing_dropi_id` |
| Tope diario de envíos reales alcanzado (justo antes de enviar) | `daily_cap_reached` |
| Orden cancelada | `CANCELLED`, sin envío |

Si la tabla `catalog_issues` (rama `feat/catalog-health`) aún no existe, se omite solo esa fuente y el resto de comprobaciones sigue aplicando.

**Pisos de margen**, calculados al `ORDER_MARGIN_REJECT_RATE` (0,30) de rechazo, con flete, devolución y comisión COD en el peor caso del rango:
- Piloto supervisado (`pilotFloor`): contribución ≥ `ORDER_PILOT_MIN_CONTRIBUTION_USD` (1,00), según la decisión del propietario de 04:10.
- Automático (`autoFloor`): ≥ `ORDER_AUTO_MIN_CONTRIBUTION_USD` (5) y ≥ `ORDER_AUTO_MIN_MARGIN_ON_NET` (15 %) de la venta neta. Es la propuesta de CEO-003 y está PROVISIONAL.

Ciudades (CEO-004): al inicio solo se permiten QUITO (802, `EC-P`, PICHINCHA) y GUAYAQUIL (732, `EC-G`, GUAYAS). Cualquier otra se bloquea con `incomplete_address` hasta que se valide su código en Dropi. El backend no puede llamar a `search_cities` (solo existe en el MCP): un operador valida la ciudad y la añade al resolver la excepción con `dropiCity: {id, name, department, stateCode}`, que se guarda en `app_settings.dropi_cities`. Si falta el dato del formato configurado (`stateCode` en `code`, `department` en `name`), la ciudad sigue bloqueada.

## 3. Outbox e idempotencia

- Clave: `shop_order_id = AYNIMAR-<id>`, que se envía a Dropi y permite buscar el pedido con `list_orders`.
- Claim atómico: `UPDATE … SET fulfillment_status='SENDING', dispatch_started_at=now()` con la condición `fulfillment_retry_count`, `dropi_order_id IS NULL`, un estado pendiente y una orden no cancelada. Si dos procesos lo intentan a la vez, solo uno lo consigue.
- **Dedupe local** en el adaptador, además del claim: dos envíos simultáneos con el mismo `shop_order_id` comparten una sola petición; tras un id se devuelve el mismo id; tras un resultado desconocido el proceso no vuelve a enviar (solo `not_created` lo libera). Es memoria del proceso: con varias réplicas, manda el claim de BD.
- **Error ambiguo** (timeout, error de red, 5xx o 2xx sin `objects.id`): pasa a `DISPATCH_UNKNOWN` con la excepción `dispatch_unknown`, cuyo campo `action` pide buscar `AYNIMAR-<id>` en el panel de Dropi antes de cualquier reenvío. Dropi no documenta consulta por `shop_order_id`. Nadie reintenta: ni el worker, ni `_dispatchOrder`, ni `/retry-fulfillment` (este devuelve 409). Una persona resuelve con `link` (lo encontró) o `not_created` (no existe, y entonces se envía una sola vez). `not_created` exige una `note` (dónde se buscó): el reenvío es manual y queda auditado (`resolved_by`, `resolved_at`, `note`).
- `SENDING` colgado más de `ORDER_SENDING_TIMEOUT_MIN` (10 min), porque el proceso murió: lo mismo que un error ambiguo.
- **Error definitivo** (4xx o transporte sin configurar): se reintenta hasta `MAX_DISPATCH_ATTEMPTS`, después pasa a `FAILED_DROPI_FULFILLMENT` con la excepción `provider_error` y un aviso por Telegram. Con `isSuccess=false`, Dropi rechazó la orden: pasa directamente a `FAILED_DROPI_FULFILLMENT` con el mensaje y sin reintento.

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
  - Después del envío: no hay API de cancelación. Se abre la excepción manual `cancelled_after_dispatch` (`action: "cancelar en el panel de Dropi"`) y se envía un aviso por Telegram.
  - En los dos casos, el contra entrega queda `not_collected`.

## 5. API de excepciones (JWT y rol admin)

- `GET /api/v1/order-exceptions?status=open|resolved|all&type=&limit=`: devuelve `{ items, count, mode }`, sin datos personales.
- `POST /api/v1/order-exceptions/:id/resolve` con el cuerpo `{ resolution, note?, dropiOrderId?, amount?, shippingCost?, providerFees?, dropiCity? }`.
  - Resoluciones: `retry`, `accept`, `manual`, `link`, `not_created`, `collected`, `not_collected`. La tabla `RESOLUTIONS` del servicio indica cuáles admite cada tipo.
  - El cierre es atómico: si dos personas resuelven a la vez, la segunda recibe 409.

## 6. Activación (requiere autorización del propietario en cada paso)

1. Staging con `DROPI_ORDER_AUTOMATION=supervised` y transporte mock: pedidos sintéticos.
2. Confirmar con soporte de Dropi, por escrito, que el token de integración WooCommerce sirve para llamar directamente a `/integrations/orders/myorders`, y el formato de `state` y `products[]` (preguntas en `ops-ceo-cto/informes/dropi-ordenes-ecuador.md` §6). Rellenar `dropi_suppliers` con datos verificados.
3. Piloto (operador manual): producción, `supervised`, `DROPI_ORDER_TRANSPORT=http`, `DROPI_ORDER_HTTP_ENABLED=true` y `DROPI_INTEGRATION_KEY`. 20 pedidos liberados uno a uno (CEO-003), con un tope diario de 5.
4. `auto` solo con `DROPI_ORDER_AUTO_ENABLED=true` y el tope diario.

Tests: `scripts/order-automation-test.js`. La parte A no usa BD y prueba el transporte contra un servidor HTTP falso en `127.0.0.1`. La parte B usa Postgres (`ORDERS_TEST_DATABASE_URL`).
