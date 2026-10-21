# 2026-10-20 — Entrada del hub WhatsApp para NutrIA (inquilino AE)

**Qué.** `POST /api/v1/hub/handle` (routes/hubRouter.js) recibe del hub multiempresa
(ecosistema-luismorla/hub, adaptador `remote` con `HUB_TENANT_AE_URL`/`HUB_TENANT_AE_SECRET`)
`{ tenantId:'AE', origin, entry, phone, msgId, text?, replyId? }` y devuelve
`{ messages:[{type:'text',text}], handoff }`. Detrás de `FLAG_NUTRIA_HUB=true` +
`HUB_SHARED_SECRET`; si falta cualquiera ⇒ 404.

**Por qué así.**
- Mismo patrón que Pulpia (Pescafast, commit 465b53d): HMAC-SHA256 de `timestamp.body`
  crudo, ventana ±5 min, `timingSafeEqual`, dedupe por `msgId`.
- El motor se EXTRAJO de `/nutria/chat` a `runNutriaTurn()` (aiRouter.js): web y WhatsApp
  usan el mismo prompt, herramientas y bucle. `/nutria/chat` devuelve exactamente lo mismo.
- Sesión siempre anónima (el hub no manda JWT): `obtener_estado_orden` responde «no
  encontrado» y remite a `/mi_cuenta/orders`; nunca consulta la BD por número.
- Acciones de navegador → texto: productos = enlace público a la ficha `/store/:id`;
  carrito/checkout = enlace de compra (contrato con el CTO de Aynimar, tienda en
  `feat/wa-buy-link`): `${NUTRIA_SHOP_URL:-https://aynimar.com}/comprar?items=<id>:<cant>[,…]&src=AE-WA`,
  ids numéricos, cantidades 1–10 (más ⇒ 10, 0/inválida ⇒ fuera), máx. 10 ítems; sin precios,
  nombres, teléfonos ni tokens. La tienda recalcula precio y stock; el checkout del backend lo
  hace desde BD con bloqueo de fila (orderService.checkout). El carrito se acumula por sesión.
- Historial (6 mensajes) y contexto en memoria, clave = HMAC(SUPPORT_PHONE_PEPPER o, de respaldo, HUB_SHARED_SECRET; teléfono), TTL 24 h,
  tope 30 mensajes/hora por remitente. El teléfono no se registra ni va al LLM.

**Descartado.**
- Sesión/dedupe en BD: requiere migración (coordinar con DATABASE) — innecesario con una réplica.
- Verificar pedido por teléfono del pedido vs `wa_id` firmado: opcional, pendiente de decisión.

**Deuda conocida / orden de despliegue** (revisión del CTO de Aynimar, 2026-10-20).
- El handoff por la palabra «persona» (además de «humano»/«asesor») puede dar falsos
  positivos («para una persona mayor…»).
- Orden obligatorio: página `/comprar` de la tienda en PRODUCCIÓN **antes** de activar
  `FLAG_NUTRIA_HUB`; si no, el enlace de compra da 404.
- Definir `SUPPORT_PHONE_PEPPER` (estable, compartido con AyniMachine) antes de activar:
  sin él, rotar `HUB_SHARED_SECRET` reinicia las sesiones.
