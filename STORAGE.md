# Firebase Storage — Aynimar

Proyecto `aynimar-1329a` · bucket `aynimar-1329a.firebasestorage.app`.
Aynimar **no** usa Firebase Authentication. Las imágenes se sirven por download
URLs tokenizadas guardadas en PostgreSQL (la BD es la **fuente de verdad** de
qué objeto está en uso).

## Contrato de rutas

Todo objeto tiene la forma `images/{categoria}/{subcarpeta}/{archivo}` (4 segmentos):

| Prefijo | Entidad | Columna(s) en Postgres |
|---|---|---|
| `images/products/**` | Producto | `products.image`, `products.images` (JSON) |
| `images/variant-images/**` | Variante de producto | `products.variants[].values[].image` (JSON) |
| `images/categories/**` | Categoría de producto / de residuo | `categories.image`, `waste_categories.image` |
| `images/business/**` | Negocio / marca | `business.image` |
| `images/wastes/**` | Residuo / materia prima | `wastes.image` |
| `images/payment-proofs/{orderId}/{file}` | Comprobante de pago DeUna | `payment_proofs.file_url` |

Una URL en esas columnas puede apuntar también a un CDN externo (Dropi
`d39ru7awumhhs2.cloudfront.net`, WooCommerce, Drive, Pinterest) — es una
referencia válida, simplemente no consume nuestro bucket.

## Subida (`src/firebase/storage/index.js` en ambos frontends)

`uploadFile(folder, file)` → `images/<folder>/<uuid>.<ext>`:
- Nombre `crypto.randomUUID()` → sin colisiones, no adivinable, sin `undefined`.
- `contentType` explícito + `Cache-Control: public,max-age=31536000,immutable`.
- **Catálogo/admin** (dashboard): se comprime a **WebP** antes de subir
  (`src/common/image/compress.js`): perfil `catalog` (0.9 MB / 1600 px) para
  producto y variantes, `admin` (0.4 MB / 1000 px) para categoría/negocio/residuo.
  Sólo se aceptan JPEG/PNG/WebP en la entrada.
- **Comprobantes** (storefront): **no** se recomprimen (son evidencia). Límite
  8 MB + MIME validado en cliente y backend.

## Security Rules — `storage.rules`

Fuente de verdad: `storage.rules` en este repo. Publicar SIEMPRE desde aquí.

- `images/payment-proofs/{orderId}/{fileName}`: `get` sí (getDownloadURL),
  `list` no, `create` sólo si `resource == null` (**sin sobrescribir**), <8 MB,
  JPEG/PNG/WebP; `update`/`delete` no.
- `images/{category}/{subfolder}/{fileName}` (catálogo): lectura/escritura/
  borrado abiertos (sin auth, como hoy) + límite 10 MB y MIME en las escrituras.
  `payment-proofs` excluido.
- Cualquier otra ruta → denegada (sin catch-all).

**Validar** (requiere JDK 21):
```
npm run storage:emulator:test    # dentro de: firebase emulators:exec --only storage
# o:
npx firebase emulators:exec --only storage --project demo-aynimar \
    'node scripts/storage-rules-emulator-test.mjs'
```
Última corrida: **30/30 casos** (incluye la validación experimental de
`resource == null` bloqueando overwrite).

**Publicar**:
```
npm run storage:rules:validate   # firebase deploy --only storage --dry-run
npm run storage:rules:deploy     # firebase deploy --only storage --project aynimar-1329a
```
Requiere `firebase login` (o `FIREBASE_TOKEN` en CI). Si no hay CLI autenticado,
pegar el contenido de `storage.rules` en Firebase Console → Storage → Rules →
Publish.

## Reconciliador Storage ↔ PostgreSQL — `scripts/storage-reconcile.js`

Compara los objetos del bucket contra las 9 columnas de referencia y clasifica.
**Dry-run por defecto — nunca borra nada** salvo `--delete` con todas sus
salvaguardas, y jamás toca `images/payment-proofs/**`.

```
npm run storage:reconcile                    # dry-run con Service Account
node scripts/storage-reconcile.js --rest      # dry-run sin SA (mientras las
                                              #   Rules permitan list)
node scripts/storage-reconcile.js --json      # + vuelca inventario completo
```

Credenciales de Storage (una):
- `FIREBASE_SERVICE_ACCOUNT_JSON='{...}'` (Firebase Console → Configuración →
  Cuentas de servicio → Generar clave privada). Rol: *Storage Object Viewer*
  (dry-run) / *Storage Object Admin* (`--delete`, credencial separada).
- `GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccount.json`.

Clasificaciones (la primera que aplica gana):

| Clasificación | Significado | Cleanup |
|---|---|---|
| `PROTECTED` | `images/payment-proofs/**` | **nunca** automático |
| `INVALID` | fuera del contrato de rutas, o JSON de BD corrupto | revisión manual |
| `IN_USE` | referenciado por fila activa | conservar |
| `IN_USE_SOFT_DELETED` | referenciado sólo por productos `is_deleted=true` | conservar; política aparte |
| `TEST` | sin referencia + nombre de prueba | no automático; limpieza manual |
| `DUPLICATE` | sin referencia + md5 idéntico a otro + fuera de gracia | candidato (opt-in) |
| `ORPHAN` | sin referencia + antigüedad ≥ 30 días | candidato |
| `UNKNOWN` | sin referencia + < 30 días | no tocar (posible subida en curso) |

Reporte → `storage-reports/<timestamp>/` (`candidates.json`, `candidates.csv`,
`summary.txt`, `report_id`). No se versiona (`.gitignore`).

### Borrado (`--delete`) — sólo con autorización explícita

NO ejecutar durante el desarrollo. Exige TODO:
```
node scripts/storage-reconcile.js --delete \
     --report-id <id de un dry-run reciente sin cambios en el bucket> \
     --confirm "BORRAR <N> OBJETOS DEL BUCKET aynimar-1329a" \
     --only ORPHAN \
     --max 50
```
Salvaguardas: report_id debe coincidir (si el bucket/BD cambió → aborta),
`--confirm` exacto, revalidación just-in-time por objeto, `payment-proofs`
hard-skip incondicional, lotes con back-off, y una fila en `storage_cleanup_log`
**antes** de cada borrado. Recomendado: activar *Object Versioning* + lifecycle
30 días en el bucket antes del primer `--delete` real (Storage no tiene papelera).

## Ciclo de vida / reemplazo de imágenes

Hoy: al reemplazar una imagen en el dashboard, la anterior queda huérfana. La
recoge el reconciliador tras el periodo de gracia (30 días). Un registro
dirigido de reemplazos (tabla `image_retention` + endpoint interno) es una
mejora futura — no implementada.

## Tabla `storage_cleanup_log`

Migración `20260908000001-create-storage-cleanup-log.js` (aditiva, reversible).
Append-only; sólo la escribe `storage-reconcile.js --delete`. No es un modelo
Sequelize a propósito (el reconciliador es standalone).
