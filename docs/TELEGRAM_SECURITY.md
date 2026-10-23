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

- **Registro**: tras `sendVideo`, `integrations/videoService.js#sendForReview` crea la fila `pending` en `creative_reviews` (ref, producto, variante, red, link UTM, caption para la red, `file_id`, `message_id`, `production_cost_usd` = 0 para el motor ffmpeg; NULL = desconocido). El kit de publicación muestra ese coste. Si la BD falla, el vídeo ya está en el chat: se registra el error saneado (`err.name`) y se avisa al admin de que esos botones no funcionarán.
- **Decisión** (`Services/creativeReviewService.js#decide`): tras `verifyCallbackQuery`, `UPDATE creative_reviews SET status, decided_at, decided_by WHERE ref=? AND status='pending'`. 0 filas → ya decidida o inexistente: se responde con el estado actual y no se toca nada (doble clic, reintentos de Telegram y carreras quedan cubiertos por la BD).
- **Tras decidir**: `answerCallbackQuery` (✅ Aprobado / ❌ Rechazado / ✏️ Cambios solicitados) → `editMessageReplyMarkup` (quita botones) → `editMessageCaption` con `Estado: …` (si falla, respuesta al vídeo). Aprobado → mensaje *KIT DE PUBLICACIÓN* (HTML escapado: texto en `<pre>`, link UTM, pasos manuales). Rechazado → confirmación. Cambios → se pide responder al vídeo o a ese mensaje.
- **Respuesta con cambios**: solo `message` nuevo del admin (from y chat), en respuesta a un mensaje del bot que contenga `Ref: <ref>`, y solo si esa pieza está en `changes_requested` → `change_request`. El texto nunca se registra en logs. Una respuesta que sea **solo 6 dígitos** va siempre al 2FA de Dropi; si la respuesta no corresponde a una pieza en `changes_requested`, sigue el flujo 2FA de siempre.
- **Comandos** (solo admin, `message` con from = chat = admin): `/estado` (10 últimas piezas + interruptor), `/stop` y `/reanudar` (no `/start`, que Telegram envía al abrir el bot) → `app_settings` claves `social.enabled` (F2) y `social.publisher.enabled` (publicador social, por defecto ausente = OFF), con log `[Social] interruptor …`. Es la pausa global del publicador social (ver `docs/SOCIAL_PUBLISHER.md`): OFF = el worker no reclama nada.
- **Nunca** se aprueba por texto libre.
- Migración: `db/migrations/20261018000001-create-creative-reviews.js` (aditiva; `down` = `DROP TABLE IF EXISTS`).
- Requisito: el webhook debe recibir `callback_query`. En staging se fija con `TELEGRAM_ALLOWED_UPDATES`; en production se mantiene la configuración actual del bot (verificar con `/telegram/debug` → `allowed_updates` nulo o con `callback_query`).
- Pruebas: `scripts/telegram-approvals-test.js`.

## Buzón del CTO (preguntas al propietario por el bot de staging)

Para que el CTO (sin acceso entrante) pregunte y lea respuestas. Sin variables nuevas ni migraciones.

- **Enviar**: `railway run -e staging -s Aynimar-staging -- node scripts/cto-ask.js ask "¿Pregunta?" "Opción A" "Opción B"` → mensaje con `Pregunta CTO-<qid>` (qid = 12 hex) y botones `mk:cq:<qid>_<n>:<hmac16>` (misma firma y verificación que las aprobaciones). Imprime el qid. El script se niega a correr en production y respeta el guard de bot no productivo.
- **Responder**: botón (se guarda `{qid, option, label}`, se responde al botón, se quitan los botones y se edita el texto con `Respuesta: …`) o *Responder* al mensaje con texto libre (`{qid, text}` + "📝 Recibido por el CTO"). Solo `message` nuevo del admin (from y chat), igual que los cambios. Una respuesta que sea **solo 6 dígitos** va al 2FA; un mensaje con `Ref:` sigue siendo de piezas. El contenido nunca se registra en logs.
- **Almacén**: `app_settings` clave `cto.inbox`, array JSON con `id` incremental y `at`; máximo 100 entradas (se descartan las más viejas). Read-modify-write sin bloqueo: suficiente para un solo admin.
- **Leer**: `railway run -e staging -s Aynimar-staging -- node scripts/cto-ask.js inbox [after]` → `GET /api/v1/ai/cto/inbox?after=<id>` en `BACKEND_URL` o, si no existe (staging), `https://$RAILWAY_PUBLIC_DOMAIN`. Header `X-CTO-Key` = HMAC-SHA256(`TELEGRAM_WEBHOOK_SECRET`, `aynimar-cto-inbox-v1`) en hex, comparado en tiempo constante. Sin secreto → 503; clave inválida → 403; `after` inválido → 400. Rotar el secreto invalida la clave y los botones.
- Pruebas: `scripts/cto-inbox-test.js` (incluido en `npm test`).

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
