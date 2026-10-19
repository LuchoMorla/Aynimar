# Telegram — endurecimiento F0

Estado: implementado en la rama `feat/f0-telegram-hardening`. **No desplegado.**
Código: `libs/telegramSecurity.js` (puro) · pruebas: `scripts/telegram-security-test.js`.

## Decisión

| Qué | Por qué | Descartado |
|---|---|---|
| Webhook fail-closed: sin `TELEGRAM_WEBHOOK_SECRET` → 503; header ausente/incorrecto → 403 (comparación en tiempo constante) | Antes el secreto era opcional y producción no lo tenía: cualquiera podía falsificar mensajes del admin (y el chat_id estaba expuesto) | Mantenerlo opcional: deja abierta la falsificación de aprobaciones futuras |
| `setWebhook` siempre con `secret_token`; `allowed_updates` solo si `TELEGRAM_ALLOWED_UPDATES` está definido | Producción conserva sus `allowed_updates` actuales; staging puede activar `callback_query` | Forzar `callback_query` en todos los entornos |
| `/telegram/debug` exige JWT `admin` (passport + `checkRoles`, ya existentes); ids enmascarados | Era público y devolvía el chat_id | Auth paralela por API key |
| Fuera de `RAILWAY_ENVIRONMENT_NAME=production`, el bot solo se usa si el id del token == `TELEGRAM_NONPROD_BOT_ID` | Un token productivo copiado a staging/local no puede sustituir el webhook productivo ni escribir al CEO | Comparar contra el id del bot productivo (requiere conocerlo en staging) |
| `callback_query`: solo del admin, en su chat, con `callback_data` `mk:<ap|rj|ch>:<ref>:<hmac16>`; desde F2 ejecuta la decisión (ver sección F2) | Aprobaciones; nunca por texto libre | Aceptar texto ("aprobar 5") — choca con el 2FA de 6 dígitos |
| Eliminado el auto-descubrimiento de chat_id | El primer desconocido que escribiera al bot habría recibido las alertas | — |
| No se registra el código OTP en logs | Higiene de secretos | — |

La clave HMAC se deriva de `TELEGRAM_WEBHOOK_SECRET`: rotarlo invalida todos los botones antiguos.
El un-solo-uso del botón lo garantiza F2 (tabla `creative_reviews`, ver abajo).

## F2 — aprobaciones de vídeos

"Aprobar" **no publica en redes** (no hay integraciones sociales): marca la pieza y envía el kit de publicación manual.

- **Registro**: tras `sendVideo`, `integrations/videoService.js#sendForReview` crea la fila `pending` en `creative_reviews` (ref, producto, variante, red, link UTM, caption para la red, `file_id`, `message_id`). Si la BD falla, el vídeo ya está en el chat: se registra el error saneado (`err.name`) y se avisa al admin de que esos botones no funcionarán.
- **Decisión** (`Services/creativeReviewService.js#decide`): tras `verifyCallbackQuery`, `UPDATE creative_reviews SET status, decided_at, decided_by WHERE ref=? AND status='pending'`. 0 filas → ya decidida o inexistente: se responde con el estado actual y no se toca nada (doble clic, reintentos de Telegram y carreras quedan cubiertos por la BD).
- **Tras decidir**: `answerCallbackQuery` (✅ Aprobado / ❌ Rechazado / ✏️ Cambios solicitados) → `editMessageReplyMarkup` (quita botones) → `editMessageCaption` con `Estado: …` (si falla, respuesta al vídeo). Aprobado → mensaje *KIT DE PUBLICACIÓN* (HTML escapado: texto en `<pre>`, link UTM, pasos manuales). Rechazado → confirmación. Cambios → se pide responder al vídeo o a ese mensaje.
- **Respuesta con cambios**: solo `message` nuevo del admin (from y chat), en respuesta a un mensaje del bot que contenga `Ref: <ref>`, y solo si esa pieza está en `changes_requested` → `change_request`. El texto nunca se registra en logs. Una respuesta que sea **solo 6 dígitos** va siempre al 2FA de Dropi; si la respuesta no corresponde a una pieza en `changes_requested`, sigue el flujo 2FA de siempre.
- **Comandos** (solo admin, `message` con from = chat = admin): `/estado` (10 últimas piezas + interruptor), `/stop` y `/start` → `app_settings` clave `social.enabled` (por defecto ausente = OFF), con log `[Social] interruptor …`. Hoy es solo un interruptor: no existe publicador.
- **Nunca** se aprueba por texto libre.
- Migración: `db/migrations/20261018000001-create-creative-reviews.js` (aditiva; `down` = `DROP TABLE IF EXISTS`).
- Requisito: el webhook debe recibir `callback_query`. En staging se fija con `TELEGRAM_ALLOWED_UPDATES`; en production se mantiene la configuración actual del bot (verificar con `/telegram/debug` → `allowed_updates` nulo o con `callback_query`).
- Pruebas: `scripts/telegram-approvals-test.js`.

## Variables nuevas

| Variable | Entorno | Secreta |
|---|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | production y staging (**valores distintos**) | Sí |
| `TELEGRAM_NONPROD_BOT_ID` | solo staging/local | No (id público del bot de pruebas) |
| `TELEGRAM_ALLOWED_UPDATES` | solo staging (por ahora) | No |

## Staging (bot de pruebas)

1. Crear un bot nuevo con @BotFather (nunca reutilizar el productivo).
2. En Railway → BAynimar → staging → Aynimar-staging → Variables (el admin las escribe; no pegarlas en chats):
   `TELEGRAM_BOT_TOKEN` (del bot de pruebas), `TELEGRAM_NONPROD_BOT_ID` (parte antes de `:`),
   `TELEGRAM_CHAT_ID` (chat del admin con el bot de pruebas), `TELEGRAM_WEBHOOK_SECRET` (aleatorio, p.ej. `openssl rand -hex 32`),
   `TELEGRAM_ALLOWED_UPDATES=message,edited_message,channel_post,callback_query`.
3. No definir `BACKEND_URL` en staging (se usa `RAILWAY_PUBLIC_DOMAIN` del propio staging). No copiar `DROPI_*`.
4. Desplegar la rama en Aynimar-staging y verificar: log `[Telegram] Webhook registrado`, `GET /api/v1/ai/telegram/debug` con JWT admin de staging.

## Despliegue a producción (requiere autorización específica — no ejecutado)

El orden importa: el código nuevo rechaza updates sin secreto, y el código viejo con la variable puesta también (Telegram aún no envía el header).

1. Generar `TELEGRAM_WEBHOOK_SECRET` (distinto del de staging) y dejarlo **staged** en Railway, sin aplicar.
2. Merge a `main` → CI (smoke + telegram tests + lint) → deploy. Aplicar la variable en el mismo deploy.
3. Al arrancar, `registerTelegramWebhook` re-registra con `secret_token` (sin tocar `allowed_updates`).
4. Verificar: `/telegram/debug` sin JWT → 401; con JWT admin → `webhook_secret_set: true`, sin `last_error_message`; aviso de deploy recibido; enviar un mensaje normal al bot (no debe pasar nada).

## Reversión

- Código: `git revert <commit>` en `main` (o redeploy del deployment anterior `73b313c` desde Railway → Deployments → Redeploy).
- Si se revierte el código, **quitar** `TELEGRAM_WEBHOOK_SECRET` de producción en el mismo paso o el código viejo rechazará los updates; el código viejo re-registra el webhook al arrancar sin `secret_token`. Se espera que eso deje el webhook sin secreto (estado anterior), pero **no está verificado**: comprobar tras el rollback que un mensaje al bot llega (log `[Telegram Webhook]`) y que el aviso de deploy funciona.
- Staging: borrar las variables `TELEGRAM_*` de Aynimar-staging y `deleteWebhook` del bot de pruebas.
