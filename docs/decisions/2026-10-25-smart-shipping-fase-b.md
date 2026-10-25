# Smart Shipping, Fase B (2026-10-25)

**Qué.** Cotizador de envío `POST /api/v1/shipping/quotes` + recálculo obligatorio al confirmar
(`_finalizeAndDispatch` para COD, `checkout()` para DeUna / créditos parciales). Arquitectura:
`ops-ceo-cto/informes/smart-shipping/01-fase-a.md`. Regla comercial: CEO-021 (PROPUESTA, sin aprobar).

**Decisiones.**
- Flag `app_settings.smart_shipping` (JSON), apagado y fail-closed. Sin variables de Railway.
- El cliente solo envía `quoteId` + `optionId`; precios, cantidades, productos y ciudad de entrega se leen de BD.
- Cotización de uso único, 15 min, ligada a orden, usuario, ciudad Dropi, método de pago y huella del carrito.
  Cualquier discrepancia → 409 con `code` (`SHIPPING_QUOTE_INVALID|USED|EXPIRED`, `SHIPPING_CHANGED`, `SHIPPING_CITY_MISMATCH`).
- Política configurable: `excess` (recargo = máx(0, coste − flete incluido) × multiplier) o `absorb` (0).
- Columnas nuevas de `orders` NO se declaran en `orderModel`: se escriben con UPDATE explícito solo con el flag
  encendido. Así, con el flag apagado o la migración sin aplicar, ninguna consulta de órdenes cambia.
- Adaptadores: `dropiTable` (tabla en `app_settings.shipping_rates`; semilla de la Fase A solo fuera de producción),
  `mock`, `dropiLive` (stub, pendiente de Dropi).

**Descartado.** Firma HMAC de la cotización (el UUID en BD basta); servicio aparte; flag en `FLAG_*` de Railway.
