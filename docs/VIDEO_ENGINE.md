# Motor de vídeo de producto

Estado: rama `feat/video-engine`. **No desplegado.**
Código: `integrations/videoService.js` · cola: `libs/videoQueue.js` · envío: `utils/telegramNotify.js#sendTelegramVideo`
· endpoint: `POST /api/v1/ai/videos` (`routes/aiRouter.js`) · CLI: `scripts/render-product-video.js` · pruebas: `scripts/video-engine-test.js`.

## Qué hace

Vídeo vertical 1080x1920 (9:16, 30 fps, H.264 + pista de audio silenciosa) con las **fotos reales** del producto
(2 a 6): fondo desenfocado, zoom lento (Ken Burns), fundido y rótulos. 3,5 s por foto. Se envía al admin por Telegram
con los botones firmados Aprobar / Rechazar / Cambios (`mk:<ap|rj|ch>:<ref>:<hmac>`) y un link con UTM:
`https://www.aynimar.com/store/{id}?utm_source=<red>&utm_medium=organic&utm_campaign=video_<variante>&utm_content=<ref>`.
Los botones aún no ejecutan nada (eso es F2). No publica en redes.

## Decisiones

| Qué | Por qué | Descartado |
|---|---|---|
| ffmpeg por `spawn` sin shell, binario del sistema (`FFMPEG_PATH`, por defecto `ffmpeg`) | Coste ~0, sin dependencias npm | Shotstack/Creatomate (proveedor + secreto), IA generativa (inventa el producto) |
| Textos por `textfile=` con `expansion=none` | Comillas, `:`, `'` o `%` del nombre no pueden romper ni inyectar el filtergraph | Interpolar en `text=` |
| Imágenes solo `https` de `firebasestorage.googleapis.com` y `d39ru7awumhhs2.cloudfront.net`, `redirect: 'error'`, `image/*`, ≤10 MB, 20 s | SSRF | — |
| Fuente Lato Black (OFL 1.1) en `assets/fonts/` | No depender de fontconfig/fuentes del sistema | — |
| Plantillas V1/V2/V3 con solo nombre (acortado a 40), precio de BD (`$12.90`) y un **beneficio escrito por el admin** (3–60 caracteres). Rechaza "envío gratis", "garantía", "contra entrega", "original" | Ningún dato sale de un LLM; no se prometen condiciones no confirmadas | Generar el beneficio con Groq |
| Un render a la vez. Con `REDIS_URL`: BullMQ `product-video` (concurrency 1, attempts 1). Sin Redis (staging): cola en memoria, máx. 3 en espera → 429 | Comparte CPU con la API (`numReplicas=1`) | Worker separado (más infraestructura) |
| ffmpeg con `-threads 2` y prioridad baja (`os.setPriority` 10) | Que la API gane la CPU | — |
| mp4 en temporal, se borra tras enviarlo; se registra el `file_id` de Telegram | MVP sin Storage | Subir a `videos/` en Storage (cuando se publique en Meta/TikTok) |

## Build en Railway

`nixpacks.toml` añade `ffmpeg` a `nixPkgs` (`railway.toml`: `builder = "nixpacks"`).
**Tras el primer deploy en staging hay que verificar** (shell de Railway):

```sh
ffmpeg -hide_banner -filters | grep drawtext   # debe aparecer; si no, cambiar a "ffmpeg-full"
ffmpeg -hide_banner -encoders | grep libx264
```

Si Railway pasa a Railpack, usar `RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg` en vez de `nixPkgs`.

## Uso

```sh
# API (JWT admin) → 202 { queued, ref, mode }
POST /api/v1/ai/videos  { "productId": 82, "variant": "v1", "benefit": "Agua y comida en un solo lugar", "network": "instagram" }

# CLI
node scripts/render-product-video.js 82 v2 "Agua y comida en un solo lugar"               # render + Telegram
node scripts/render-product-video.js 82 v2 "Agua y comida en un solo lugar" --out v.mp4   # solo archivo
```

## Coste medido (prototipo, ffmpeg 4.2 local)

5 fotos → 17,5 s de vídeo, 2,1 MB, 46 s de render, ~373 MB RSS de ffmpeg. En Railway compite con la API: medir en staging.

## Pruebas

`npm test` incluye `scripts/video-engine-test.js`. El render real solo corre con `FFMPEG_PATH` apuntando a un binario;
sin él se salta con aviso.
