# Publicador social — calendario editorial, aprobación por Telegram y cola en Postgres

Estado: rama `feat/social-publisher`. **No desplegado en producción.** Sin credenciales de ninguna red:
todo está desactivado (NO CONFIGURADO) salvo el adaptador `mock` fuera de producción.

## Flujo

```
Admin (JWT admin)                          Telegram (admin, botones HMAC)                Worker (Postgres, sin Redis)
POST /social/campaigns                     
POST /social/campaigns/:id/pieces  ──┐     
POST /social/pieces/:id/posts        │     
PATCH /social/posts/:id ── invalida ─┤     
POST /social/pieces/:id/review ──────┴──▶  vídeo + ficha por red (texto exacto,      
                                           fecha local, vía, link UTM) + botones
                                           mk:<ap|rj|ch>:<ref s…>:<hmac>
                                           │
                     webhook ──────────────┘  decidePackage (1 transacción, FOR UPDATE):
                                              pending? hash actual == hash enviado?
                                              ap → posts draft→queued (vía manual → manual_required + kit)
                                              rj / ch → nada se encola (motivo por respuesta)
                                                         │
                                                         ▼
                                           claimNext: UPDATE … WHERE id=(SELECT … FOR UPDATE SKIP LOCKED)
                                           y social.enabled='true'  → publishing (attempts+1)
                                                         │
                       comprobaciones: aprobación vigente · hash del paquete · lista blanca ·
                       vía configurada · credenciales · formato · sha256 del mp4 descargado
                                                         │
                       adaptador: instagram (Graph) · facebook (Video Reels) · youtube (Data API v3)
                                  buffer (TikTok; YouTube si se elige) · mock
                                                         │
                       published (+verify → verified_at) │ temporary → queued con backoff (máx. 5)
                       permanent → failed                │ unknown / worker caído → manual_required
                                                         ▼
                                           Alerta Telegram: ✅ publicada · ❌ fallo · 🖐 paso manual · ⛔ bloqueada
```

## Decisiones

| Qué | Por qué | Descartado |
|---|---|---|
| Cola = tabla `social_posts` en Postgres; reclamo con `FOR UPDATE SKIP LOCKED` en un único `UPDATE` | Staging no tiene Redis; la BD ya es la fuente de verdad y da transacciones con la aprobación | BullMQ (no hay Redis en staging; dos fuentes de verdad) |
| `UNIQUE (piece_id, network)` | Una pieza-versión va a una red **una vez y por una sola vía** (api, buffer o manual): imposible por diseño publicar por API y por Buffer a la vez | Comprobación solo en código |
| Aprobación = sha256 canónico del paquete (sha256 del mp4 + ref + versión + por red: vía, fecha UTC, zona, texto, link) guardado en `creative_reviews.package_hash` | El botón aprueba exactamente lo enviado; el hash se recalcula al aprobar y **otra vez en el worker** antes de publicar | Aprobar solo la pieza (permitiría cambiar textos u horarios tras aprobar) |
| Reutilizar `creative_reviews` (+ `piece_id`, `package_hash`, `superseded_at` nullable) y el webhook F2 | Mismos botones firmados, transición atómica, respuestas con cambios, `/estado`; refs `s<pieza>x…` distinguen paquetes de vídeos F2 | Tabla de revisiones paralela |
| Editar un paquete pendiente/aprobado → `invalidated`, botones anulados (`superseded_at`), `queued` → `draft` | "Cualquier cambio sustancial exige nueva aprobación" | Re-aprobar automáticamente |
| Al menos una vez **no**: como mucho una vez. Solo `temporary` se reintenta; `unknown` (timeout/5xx en el paso final) y `publishing` caducado → `manual_required` | Un reintento ciego tras un resultado incierto puede duplicar la publicación | Reintentar todo error |
| Pausa global = `app_settings social.enabled` (ya existente, `/stop` `/reanudar`), comprobada **dentro** del `UPDATE` de reclamo | Una sola sentencia: no hay ventana entre comprobar y reclamar. Por defecto OFF | Variable de entorno (exige redeploy) |
| Lista blanca `SOCIAL_ALLOWED_NETWORKS` (vacía = ninguna). El worker solo arranca si hay alguna red | Producción no cambia de comportamiento al desplegar | Activar por credencial presente |
| Una vía por red: `SOCIAL_NETWORK_CHANNELS` (por defecto `instagram:api,facebook:api,tiktok:buffer,youtube:api`) | IG/FB por la API de Meta (usuario de sistema); TikTok por Buffer (una app propia sin auditoría solo publica en privado); YouTube por API propia o Buffer, nunca ambas | API propia de TikTok |
| Vídeo: `social_pieces.video_url` https en hosts permitidos (`SOCIAL_VIDEO_HOSTS`, por defecto Firebase Storage); el worker lo descarga y comprueba su sha256 antes de publicar | Meta, TikTok/Buffer necesitan una URL pública; el bucket ya existe y sus download URLs son tokenizadas (no adivinables). La comprobación del hash garantiza que es el archivo aprobado | Endpoint del backend que sirva el mp4 (Railway sin disco persistente; streaming por la API). URL firmada V4 temporal (requiere cuenta de servicio con acceso al bucket: NO CONFIGURADO — mejora futura) |
| SQL explícito en `Services/socialPublisherService.js`, sin modelos Sequelize nuevos | Los bloqueos y transiciones condicionadas son el núcleo de la garantía; el modelo `CreativeReview` no declara columnas nuevas, así el flujo F2 funciona aunque la migración no se haya aplicado | Modelos ORM |

Riesgo residual: la plataforma descarga la URL después de nuestra comprobación del sha256; los objetos del
bucket deben ser inmutables (nombre único por versión). Lo programado durante una pausa sale al reanudar (tarde).

## Datos (migraciones aditivas)

- `20261019000001-create-social-publisher.js`: `social_campaigns`, `social_pieces` (UNIQUE ref+version, sha256 CHECK),
  `social_posts` (UNIQUE piece_id+network, estados `draft|queued|publishing|published|failed|manual_required|blocked`,
  intentos, `next_attempt_at`, lock, error, id/URL externos, `published_at`, `verified_at`), `social_approval_events`.
- `20261019000002-add-package-to-creative-reviews.js`: columnas nullable `piece_id`, `package_hash`, `superseded_at`.
- `down`: `DROP TABLE IF EXISTS` / `DROP COLUMN IF EXISTS`.

## Endpoints (`/api/v1/social`, JWT + rol admin)

`GET/POST /campaigns` · `POST /campaigns/:id/pieces` · `POST /pieces/:id/posts` (hora local de la cuenta,
zona por defecto `America/Guayaquil`) · `PATCH /posts/:id` · `POST /pieces/:id/review` · `GET /calendar?from&to` ·
`GET /status` (campañas → piezas → estado por red, pausa, redes con CONFIGURADO/NO CONFIGURADO).

UTM: `utm_source=<red>`, `utm_medium=organic`, `utm_content=<ref>`. `utm_campaign` = `utmCampaign` de la
publicación (POST/PATCH, `[A-Za-z0-9_.-]{1,64}`, p. ej. `s1_oct26` del calendario del CMO); si no viene,
`social_c<id campaña>`. Solo se genera link si la campaña tiene `productId` (enlace a `/store/<id>`).

## Variables (todas NO CONFIGURADAS hoy)

| Variable | Red | Secreta |
|---|---|---|
| `SOCIAL_ALLOWED_NETWORKS` | lista blanca | No |
| `SOCIAL_NETWORK_CHANNELS`, `SOCIAL_VIDEO_HOSTS`, `SOCIAL_RETRY_BASE_MS`, `SOCIAL_WORKER_INTERVAL_MS`, `SOCIAL_LOCK_TIMEOUT_MS` | ajustes | No |
| `META_SYSTEM_USER_TOKEN` (+ `META_IG_USER_ID`, `META_PAGE_ID`, `META_GRAPH_VERSION`) | Instagram / Facebook | Token sí |
| `BUFFER_API_KEY` (+ `BUFFER_CHANNEL_TIKTOK`, `BUFFER_CHANNEL_YOUTUBE`) | TikTok / YouTube vía Buffer | Clave sí |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` (+ `YOUTUBE_PRIVACY`, por defecto `private`) | YouTube API propia | Secret y refresh sí |

Las cargan el propietario en Railway (primero staging), nunca un agente.

## Pruebas

`scripts/social-publisher-test.js`: parte A sin BD (hash, zonas, formato, rutas, adaptadores contra APIs falsas);
parte B con `SOCIAL_TEST_DATABASE_URL` (Postgres real en un schema temporal que se borra; aborta si el host es de
producción): callbacks x3 en paralelo, 2 procesos worker + el principal, pausa, reintentos, rechazo/cambios,
edición tras aprobar, manipulación directa en BD, sha256 distinto, errores permanentes/inciertos, máx. intentos,
worker caído, panel y `/estado`.
