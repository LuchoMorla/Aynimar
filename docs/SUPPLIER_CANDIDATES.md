# Proveedores alternativos (supplier_candidates)

Busca, compara, clasifica y vigila artículos de Dropi que puedan servir un producto de la tienda. **No llama a Dropi** (los datos llegan exportados del conector MCP de solo lectura), **no toca el producto** y **no toca pedidos**. Aplicar un cambio de proveedor sigue siendo la decisión `swap_dropi_id` de Salud del catálogo, que toma el propietario.

## Decisión
Tabla aditiva `supplier_candidates` en lugar de ampliar `catalog_issues`: un issue es un problema del producto (uno abierto por tipo); un candidato es un artículo con estado y auditoría propios, varios por producto. Ampliar `details` de un issue habría mezclado estados y perdido la auditoría por candidato.

Migración `20261020000005-create-supplier-candidates.js`: `CREATE TABLE IF NOT EXISTS`, índice único `(product_id, dropi_product_id, COALESCE(dropi_variation_id,''))` e índice único parcial `(product_id) WHERE status='preparado_preferente'` (un preferente por producto). `down` = `DROP TABLE IF EXISTS`. FK a `products` con `ON DELETE CASCADE`.

## Motor (Services/supplierCandidateService.js, puro y determinista)
- **Texto**: tokens sin tildes, plurales ni palabras vacías; «2 en 1» → `2en1`, «F-01» → `f01`, «30 kg» → `30kg`, `x2`. Sinónimos explícitos (comedor/comida → comedero; se listan en la evidencia). Puntuación = Jaccard. Atributos clave de la tienda: tipo (primer sustantivo no genérico), medidas, «N en M», modelo (letras+dígitos), marca (campo `brand` del export o lista corta), cantidad y accesorios. `conflicts` = el candidato dice otra cosa; `missing` = no lo menciona.
- **Imagen**: Hamming entre dHash de 64 bits (≤ 6 casi idéntica, ≤ 14 parecida, si no distinta). El backend no tiene librería de imagen instalada: el hash se calcula fuera (`scripts/supplier-image-dhash.py`, Pillow, solo archivos locales). Sin hash → `sin_comparar`.
- **Precio/stock**: coste total = coste + flete (real o estimado, con su fuente; sin flete, 7.96 del rango 5.10–7.96). Contribución con `financeContribution` (PVP con IVA 15 %, comisión 3 %, devolución = flete de ida) con rechazo 15 % y 30 %, y PVP de equilibrio. Stock `confirmado` solo si el dato tiene fecha y menos de 72 h.
- **Clasificación**:
  - `DISTINTO`: algún conflicto, ≥ 2 atributos clave sin mencionar, Jaccard < 0.3 o imagen distinta.
  - `EXACTO`: ningún atributo clave falta y (imagen casi idéntica, o sin imagen pero marca y modelo idénticos).
  - `SIMILAR`: el resto. Todo lo que no sea EXACTO es una **sustitución**: `requiresCustomerAcceptance: true`.
- Verificado/premium/nombre del proveedor: solo si vienen de Dropi. `list_products` no los da → `null` = sin datos.

## Estados y reglas
`propuesto` → `preparado_preferente` | `descartado` | `aprobado_por_propietario`; `preparado_preferente` → `propuesto` | `descartado` | `aprobado_por_propietario`; `descartado` → `propuesto`; `aprobado_por_propietario` → `propuesto` | `descartado`.

`preparado_preferente` exige las cuatro comprobaciones (`preferredChecks`), re-evaluadas con el coste actual del producto: `articulo_identico` (EXACTO), `proveedor_confiable` (verificado o premium = true desde Dropi), `disponibilidad_confirmada` (stock > 0 y fresco) y `coste_total_igual_o_menor` (frente a `costPrice` + flete; sin coste de referencia, no). Si falla → 422 con `checks`. El refresh vigila: un preferente que deja de cumplir vuelve a `propuesto` con entrada en `history`. `aprobado_por_propietario` exige nota. Cada cambio añade `{at, by, from, to, note, checks?}` a `history`.

## API (admin, bajo /api/v1/catalog-health)
- `GET /supplier-candidates?productId=&status=` → `{ generatedAt, products: [{ productId, productName, productPrice, costPrice, dropiProductId, preferred, candidates[] }] }`.
- `POST /supplier-candidates/:id/status` `{ status, note? }` → candidato actualizado. 400 validación, 404, 409 transición o ya hay preferente, 422 reglas.
Contrato completo con ejemplos: `ops-ceo-cto/informes/proveedores-contrato.md`.

## Ingesta
```
node scripts/supplier-candidates-refresh.js --equivalencias informes/equivalencias-dropi.csv [--margenes margenes.csv] [--checked-at ISO]
node scripts/supplier-candidates-refresh.js --dropi-json export.json [--product 82]
node scripts/supplier-candidates-refresh.js ... --dry-run --products snapshot.json   # sin BD, imprime JSON
```
Formato del export (`test/fixtures/dropi-export-82.json`): `{ exportedAt, products: [{ productId, storeImageHash?, storeBrand?, freight?: {value, source}, items: [<producto crudo de list_products>] }] }`. Los productos con variantes generan un candidato por variante.

## Tests
`node scripts/supplier-candidates-test.js` (parte A sin BD). Parte B con `CATALOG_TEST_DATABASE_URL` (schema temporal `suppliers_test_<pid>`, se borra al terminar; aborta con `roundhouse*`). `SUPPLIER_EQUIV_CSV` añade el CSV real.
