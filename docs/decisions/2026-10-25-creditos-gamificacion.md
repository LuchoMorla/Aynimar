# 2026-10-25 · Créditos por gamificación desactivados

- **Qué:** `POST /api/v1/gamification/complete-challenge` ya no acredita Ayni-Créditos.
  Solo marca el reto como completado (UPDATE condicional: una vez por día; repetir → 409)
  y responde `credited: 0`. La regla anterior (créditos de la plantilla si `orderAmountUsd`
  ≥ umbral) se conserva en el código detrás de `CHALLENGE_CREDITS_ENABLED = false`
  (`routes/gamificationRouter.js`).
- **Por qué:** auditoría `ops-ceo-cto/informes/ayni-play/02-reciclaje-creditos.md`.
  - R1: el cliente fijaba el monto y los slugs de plantilla no tenían control de
    «ya completado» → acuñación ilimitada de créditos.
  - R2: la tienda llama al endpoint al CREAR el pedido (COD/DeUna/créditos) con el
    subtotal del carrito → 20–75 créditos por pedidos de 20–75 $ = reembolso del 100 %,
    aunque el pedido se cancele. Incompatible con el piso de margen del 30 %.
- **Reactivar:** requiere aprobación de Luis y una regla nueva que verifique en servidor
  un pedido propio y entregado (nunca `orderAmountUsd`), respete el margen ≥30 % y escriba
  en `wallet_transactions`. `scripts/creditos-security-test.js` falla si la constante es `true`.
- **Alternativas descartadas:** flag por variable de entorno (se podría encender sin
  revisión de código); validar el pedido en servidor ya (es una regla de negocio nueva,
  no autorizada).
- **Pendiente (propuesta, sin migración aplicada):** índice UNIQUE
  `wallet_transactions(reference_type, reference_id)` para blindar la liquidación;
  hoy se serializa con `SELECT … FOR UPDATE` sobre `payments_wastes`.
