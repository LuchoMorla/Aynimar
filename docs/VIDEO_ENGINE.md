# Motor de vídeo de producto

Estado: rama `feat/video-engine`. **No desplegado.**
Código: `integrations/videoService.js` · cola: `libs/videoQueue.js` · envío: `utils/telegramNotify.js#sendTelegramVideo`
· endpoint: `POST /api/v1/ai/videos` (`routes/aiRouter.js`) · CLI: `scripts/render-product-video.js` · pruebas: `scripts/video-engine-test.js`.

## Qué hace

Vídeo vertical 1080x1920 (9:16, 30 fps, H.264 + pista de audio silenciosa) con las **fotos reales** del producto
(2 a 6): fondo desenfocado, zoom lento (Ken Burns), fundido y rótulos. 3,5 s por foto. Se envía al admin por Telegram
con los botones firmados Aprobar / Rechazar / Cambios (`mk:<ap|rj|ch>:<ref>:<hmac>`) y un link con UTM:
`https://www.aynimar.com/store/{id}?utm_source=<red>&utm_medium=organic&utm_campaign=video_<variante>&utm_content=<ref>`.
La base es configurable con `STORE_BASE_URL` (no secreta; p.ej. la tienda de staging para probar atribución). Se exige `https://host[/ruta]` sin query, hash ni credenciales; la barra final se quita. Si falta o es inválida se usa `https://www.aynimar.com` (con aviso en log).
Desde F2 los botones registran la decisión en `creative_reviews` y "Aprobar" envía el kit de publicación manual (ver docs/TELEGRAM_SECURITY.md, sección F2). No publica en redes.

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

## QA de movimiento y montaje de clips (rama `feat/motion-qa`, herramientas offline)

No corren en Railway ni en `npm test`: necesitan python3 con `opencv-python` y `numpy`.

- `scripts/motion-qa.py vídeo.mp4 [--min-real 0.6]` → JSON con % de duración con movimiento real, tramos estáticos,
  planos y PASA/FALLA (código 0/1). Compensa la transformación global (afín LK+RANSAC refinada con ECC, dos capas)
  y descarta rótulos fijos; lo que queda es acción real. `--min-real 0.25` para cribar material bruto de proveedor.
  Medido: v82b 7,4 % FALLA · v82c 31,2 % FALLA · v82d 76,4 % PASA.
- `scripts/supplier-clip-edit.py guion.json salida.mp4` → 1080x1920 con vídeos/fotos del proveedor y clips pagados
  o genéricos, subtítulos ASS, ducking, −14 LUFS y CTA; ejecuta el QA y sale con 1 si la pieza no es apta.
  Las fotos entran como plano fijo (sin Ken Burns) y el QA las cuenta como estáticas.
- Prueba: `python3 scripts/motion-qa-test.py` (sintética; con `FFMPEG_PATH` prueba también el montaje).

| Qué | Por qué | Descartado |
|---|---|---|
| Residuo tras compensar afín + mínimo con "sin mover" + umbral relativo al gradiente | Ken Burns y rótulos fijos dan ~0; un borde desalineado 0,3 px no cuenta | Flujo óptico denso (ruidoso en fondos desenfocados), solo diferencia de fotogramas (el zoom cuenta como movimiento) |
| Python + OpenCV, fuera de la API | Ya instalado en la máquina de producción de contenido; coste 0 | Añadir opencv al backend Node |
