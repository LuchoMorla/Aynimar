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
- Acciones de navegador → texto: productos y «agregar al carrito» = enlace público a la
  ficha `/store/:id`; checkout = enlace `/checkout`. Sin tokens ni datos personales; el
  checkout recalcula precio y stock desde BD con bloqueo de fila (orderService.checkout).
- Historial (6 mensajes) y contexto en memoria, clave = HMAC(secreto, teléfono), TTL 24 h,
  tope 30 mensajes/hora por remitente. El teléfono no se registra ni va al LLM.

**Descartado.**
- Carrito prellenado por URL: la tienda no lo soporta hoy (requiere cambio de frontend).
- Sesión/dedupe en BD: requiere migración (coordinar con DATABASE) — innecesario con una réplica.
- Verificar pedido por teléfono del pedido vs `wa_id` firmado: opcional, pendiente de decisión.
