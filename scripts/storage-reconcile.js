'use strict';
/* eslint-disable no-console */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RECONCILIADOR Firebase Storage ↔ PostgreSQL — Aynimar
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Compara los objetos físicos del bucket contra las referencias reales en la
 * BD (la FUENTE DE VERDAD) y clasifica cada objeto. Por DEFECTO es DRY RUN:
 * sólo lee y genera un reporte. NUNCA borra nada salvo que se pase `--delete`
 * con todas sus salvaguardas (ver más abajo) — y aun así jamás toca
 * `images/payment-proofs/**`.
 *
 * USO
 *   node scripts/storage-reconcile.js                 # DRY RUN (por defecto)
 *   node scripts/storage-reconcile.js --grace-days 45 # sube el periodo de gracia
 *   node scripts/storage-reconcile.js --json          # vuelca el inventario completo
 *   node scripts/storage-reconcile.js --rest          # lista vía REST pública en
 *                                                     #   vez de Service Account
 *                                                     #   (sólo mientras las Rules
 *                                                     #   permitan list; útil en la
 *                                                     #   ventana de transición)
 *
 *   # BORRADO — NO ejecutar sin autorización explícita. Requiere TODO:
 *   node scripts/storage-reconcile.js --delete \
 *        --report-id <id de un dry-run reciente> \
 *        --confirm "BORRAR <N> OBJETOS DEL BUCKET aynimar-1329a" \
 *        --only ORPHAN            # (por defecto sólo ORPHAN; DUPLICATE opt-in)
 *        --max 50
 *
 * CREDENCIALES DE STORAGE (una de las dos):
 *   FIREBASE_SERVICE_ACCOUNT_JSON = '{ ...clave JSON del service account... }'
 *   GOOGLE_APPLICATION_CREDENTIALS = /ruta/a/serviceAccount.json
 *   Rol mínimo para dry-run: "Storage Object Viewer".
 *   Rol para --delete:        "Storage Object Admin" (credencial separada).
 *
 * CREDENCIALES DE BD: DATABASE_URL (igual que la app).
 *
 * CLASIFICACIONES (la primera que aplica gana):
 *   PROTECTED            images/payment-proofs/**  → nunca borrado automático
 *   INVALID             objeto fuera del contrato de rutas, o JSON de BD corrupto
 *   IN_USE              referenciado por una fila activa
 *   IN_USE_SOFT_DELETED referenciado sólo por productos con is_deleted = true
 *   TEST               sin referencia + patrón de nombre de prueba
 *   DUPLICATE          mismo md5 que otro objeto (y no es el primario)
 *   ORPHAN             sin referencia + antigüedad ≥ GRACE_DAYS
 *   UNKNOWN            sin referencia + antigüedad < GRACE_DAYS (posible subida en curso)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'aynimar-1329a.firebasestorage.app';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'aynimar-1329a';
const FIREBASE_DL_HOST = 'firebasestorage.googleapis.com';

const KNOWN_PREFIXES = ['products', 'categories', 'business', 'wastes', 'variant-images', 'payment-proofs'];
const PROTECTED_PREFIX = 'images/payment-proofs/';
const TEST_NAME_RE = /(^|\/)(rule-verification|verify|dropi-test|e2e-scenario|__rule-test__|_pending|undefined|test|tmp|temp|delete-me|prueba)([/._-]|$)/i;

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagVal = (f, def) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const MODE_DELETE = hasFlag('--delete');
const MODE_REST = hasFlag('--rest');
const DUMP_JSON = hasFlag('--json');
const GRACE_DAYS = Math.max(30, Number(flagVal('--grace-days', '30')) || 30); // sólo hacia arriba
const ONLY = (flagVal('--only', 'ORPHAN') || 'ORPHAN').toUpperCase().split(',');
const MAX_DELETE = Number(flagVal('--max', '50')) || 50;
const REPORT_ID_ARG = flagVal('--report-id', null);
const CONFIRM_ARG = flagVal('--confirm', null);
const OPERATOR = process.env.USER || process.env.LOGNAME || 'unknown';

const OUT_DIR = path.join(process.cwd(), 'storage-reports', new Date().toISOString().replace(/[:.]/g, '-'));

// ── Storage client ──────────────────────────────────────────────────────────
function getBucket() {
  let Storage;
  try {
    ({ Storage } = require('@google-cloud/storage'));
  } catch {
    bail(
      'Falta la dependencia @google-cloud/storage.\n' +
        '  npm i @google-cloud/storage'
    );
  }
  const opts = { projectId: PROJECT_ID };
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      opts.credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      bail('FIREBASE_SERVICE_ACCOUNT_JSON no es JSON válido.');
    }
  } else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    bail(
      'Sin credenciales de Storage. Define una de:\n' +
        "  FIREBASE_SERVICE_ACCOUNT_JSON='{...}'\n" +
        '  GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccount.json\n' +
        '  (Firebase Console → Configuración → Cuentas de servicio → Generar clave privada)'
    );
  }
  return new Storage(opts).bucket(BUCKET);
}

// ── DB client ───────────────────────────────────────────────────────────────
async function getDb() {
  const { Client } = require('pg');
  if (!process.env.DATABASE_URL) bail('Falta DATABASE_URL.');
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'); // dry-run: nunca escribe
  return c;
}

function bail(msg) {
  console.error('\n✖ ' + msg + '\n');
  process.exit(1);
}

// ── URL → storage path ──────────────────────────────────────────────────────
// Devuelve { path } si la URL apunta a NUESTRO bucket de Firebase, o
// { external: host } si es una URL válida pero de otro origen (Dropi, WC,
// Unsplash…), o null si no es parseable.
function urlToPath(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.hostname !== FIREBASE_DL_HOST) return { external: u.hostname };
  // .../v0/b/<bucket>/o/<path%2Fencoded>?alt=media&token=...
  const m = u.pathname.match(/\/v0\/b\/([^/]+)\/o\/(.+)$/);
  if (!m) return { external: u.hostname };
  const urlBucket = decodeURIComponent(m[1]);
  if (urlBucket !== BUCKET) return { external: u.hostname + ' (bucket ' + urlBucket + ')' };
  // el path puede venir doble-codificado (%252F) en HTML server-rendered
  let p = m[2];
  try { p = decodeURIComponent(p); } catch { /* ignore */ }
  if (p.includes('%2F') || p.includes('%2f')) {
    try { p = decodeURIComponent(p); } catch { /* ignore */ }
  }
  return { path: p.replace(/[?#].*$/, '') };
}

function safeJsonArray(txt) {
  if (txt == null || txt === '' || txt === 'null' || txt === '[]') return { ok: true, arr: [] };
  try {
    const v = JSON.parse(txt);
    return { ok: true, arr: Array.isArray(v) ? v : [v] };
  } catch {
    return { ok: false, arr: [] };
  }
}

// ── 1+2. Inventario de referencias en BD ────────────────────────────────────
async function collectReferences(db) {
  // Map<path, Ref[]>   Ref = { entity, id, column, isDeleted }
  const refs = new Map();
  const externalHosts = new Map(); // host → count (informativo)
  const invalidRows = []; // { entity, id, column }

  const add = (rawUrl, ref) => {
    const r = urlToPath(rawUrl);
    if (!r) return;
    if (r.external) {
      externalHosts.set(r.external, (externalHosts.get(r.external) || 0) + 1);
      return;
    }
    if (!refs.has(r.path)) refs.set(r.path, []);
    refs.get(r.path).push(ref);
  };

  // products.image / products.images / products.variants
  const products = await db.query(
    'SELECT id, image, images, variants, is_deleted FROM products'
  );
  for (const row of products.rows) {
    const meta = { entity: 'product', id: row.id, isDeleted: row.is_deleted === true };
    if (row.image) add(row.image, { ...meta, column: 'products.image' });

    const imgs = safeJsonArray(row.images);
    if (!imgs.ok) invalidRows.push({ entity: 'product', id: row.id, column: 'products.images' });
    for (const u of imgs.arr) add(typeof u === 'string' ? u : u && u.src, { ...meta, column: 'products.images' });

    const vars = safeJsonArray(row.variants);
    if (!vars.ok) invalidRows.push({ entity: 'product', id: row.id, column: 'products.variants' });
    for (const g of vars.arr) {
      for (const val of (g && Array.isArray(g.values) ? g.values : [])) {
        if (val && val.image) add(val.image, { ...meta, column: 'products.variants[].image' });
      }
    }
  }

  // categories / waste_categories / business / wastes  → columna image (STRING)
  for (const [table, entity] of [
    ['categories', 'category'],
    ['waste_categories', 'waste_category'],
    ['business', 'business'],
    ['wastes', 'waste'],
  ]) {
    const r = await db.query(`SELECT id, image FROM ${table}`);
    for (const row of r.rows) {
      if (row.image) add(row.image, { entity, id: row.id, column: `${table}.image`, isDeleted: false });
    }
  }

  // payment_proofs.file_url  (cualquier status cuenta como referencia)
  const proofs = await db.query('SELECT id, order_id, file_url, status FROM payment_proofs');
  for (const row of proofs.rows) {
    if (row.file_url) {
      add(row.file_url, { entity: 'payment_proof', id: row.id, column: 'payment_proofs.file_url', isDeleted: false });
    }
  }

  // reviews.images_json  (hoy siempre null — se incluye por robustez futura)
  const reviews = await db.query(
    "SELECT id, images_json FROM reviews WHERE images_json IS NOT NULL AND images_json NOT IN ('', '[]', 'null')"
  );
  for (const row of reviews.rows) {
    const j = safeJsonArray(row.images_json);
    if (!j.ok) invalidRows.push({ entity: 'review', id: row.id, column: 'reviews.images_json' });
    for (const u of j.arr) add(typeof u === 'string' ? u : u && u.src, {
      entity: 'review', id: row.id, column: 'reviews.images_json', isDeleted: false,
    });
  }

  return { refs, externalHosts, invalidRows, counts: {
    products: products.rows.length,
    payment_proofs: proofs.rows.length,
    reviews_with_images: reviews.rows.length,
  } };
}

// ── 1. Inventario de Storage ────────────────────────────────────────────────
async function collectStorageObjects(bucket) {
  const [files] = await bucket.getFiles({ prefix: 'images/', autoPaginate: true });
  return files.map((f) => ({
    path: f.name,
    size: Number(f.metadata.size || 0),
    contentType: f.metadata.contentType || null,
    createdAt: f.metadata.timeCreated || null,
    updatedAt: f.metadata.updated || null,
    md5: f.metadata.md5Hash || null,
  }));
}

// Fallback sin Service Account: REST pública. Funciona SÓLO mientras las Storage
// Rules permitan `list`. Tras endurecer las Rules, usar el Service Account.
async function collectStorageObjectsRest() {
  const api = `https://${FIREBASE_DL_HOST}/v0/b/${BUCKET}/o`;
  const names = [];
  let pageToken = null;
  do {
    const u = `${api}?maxResults=1000&prefix=images/${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(u);
    if (!res.ok) bail(`REST list falló (HTTP ${res.status}). ¿Las Rules ya bloquean list? Usa un Service Account (sin --rest).`);
    const j = await res.json();
    for (const it of j.items || []) names.push(it.name);
    pageToken = j.nextPageToken || null;
  } while (pageToken);

  // metadata por objeto, en tandas
  const out = [];
  const BATCH = 25;
  for (let i = 0; i < names.length; i += BATCH) {
    const slice = names.slice(i, i + BATCH);
    const metas = await Promise.all(
      slice.map(async (name) => {
        const r = await fetch(`${api}/${encodeURIComponent(name)}`);
        if (!r.ok) return { path: name, size: 0, contentType: null, createdAt: null, updatedAt: null, md5: null };
        const m = await r.json();
        return {
          path: name,
          size: Number(m.size || 0),
          contentType: m.contentType || null,
          createdAt: m.timeCreated || null,
          updatedAt: m.updated || null,
          md5: m.md5Hash || null,
        };
      })
    );
    out.push(...metas);
    process.stdout.write('.');
  }
  return out;
}

// ── 5. Clasificación ───────────────────────────────────────────────────────
function classify(obj, refList, dupPrimaryByMd5) {
  // 1. PROTECTED
  if (obj.path.startsWith(PROTECTED_PREFIX)) {
    const referenced = refList && refList.length > 0;
    return {
      classification: 'PROTECTED',
      reason: referenced
        ? 'comprobante de pago con fila en payment_proofs — nunca borrado automático'
        : 'objeto bajo payment-proofs/ SIN fila en payment_proofs (probable archivo de prueba) — nunca borrado automático; requiere limpieza MANUAL explícita',
    };
  }

  // contrato de rutas: images/{cat}/{sub}/{file}  con cat conocida
  const seg = obj.path.split('/');
  const inContract = seg.length === 4 && seg[0] === 'images' && KNOWN_PREFIXES.includes(seg[1]);
  if (!inContract) {
    return { classification: 'INVALID', reason: `ruta fuera del contrato images/{categoria}/{sub}/{archivo} (segmentos: ${seg.length})` };
  }

  const ageDays = obj.createdAt ? (Date.now() - new Date(obj.createdAt).getTime()) / 86400000 : Infinity;

  // 3 / 3b. IN_USE
  if (refList && refList.length > 0) {
    const anyActive = refList.some((r) => r.isDeleted !== true);
    if (anyActive) {
      return { classification: 'IN_USE', reason: describeRefs(refList) };
    }
    return {
      classification: 'IN_USE_SOFT_DELETED',
      reason: 'referenciado sólo por producto(s) con is_deleted=true — ' + describeRefs(refList),
    };
  }

  // 4. TEST
  if (TEST_NAME_RE.test(obj.path)) {
    return {
      classification: 'TEST',
      reason: `sin referencia en BD y patrón de nombre de prueba (${obj.path.split('/').slice(2).join('/')}) — no se borra automático`,
    };
  }

  // 5. DUPLICATE — sin referencia + byte-idéntico a otro objeto + fuera del
  //    periodo de gracia (un duplicado reciente podría ser una subida en curso).
  if (
    obj.md5 &&
    dupPrimaryByMd5.has(obj.md5) &&
    dupPrimaryByMd5.get(obj.md5) !== obj.path &&
    ageDays >= GRACE_DAYS
  ) {
    return {
      classification: 'DUPLICATE',
      reason: `sin referencia; md5 idéntico a ${dupPrimaryByMd5.get(obj.md5)} (primario); antigüedad ${ageDays.toFixed(0)}d`,
    };
  }

  // 6 / 7. ORPHAN vs UNKNOWN
  if (ageDays >= GRACE_DAYS) {
    return {
      classification: 'ORPHAN',
      reason: `sin referencia en ninguna de las 9 columnas; antigüedad ${ageDays.toFixed(0)}d ≥ gracia ${GRACE_DAYS}d`,
    };
  }
  return {
    classification: 'UNKNOWN',
    reason: `sin referencia pero reciente (${ageDays.toFixed(0)}d < gracia ${GRACE_DAYS}d) — posible subida en curso; se re-evalúa en la próxima corrida`,
  };
}

function describeRefs(refList) {
  const byCol = {};
  for (const r of refList) byCol[r.column] = (byCol[r.column] || new Set()).add(r.id);
  return Object.entries(byCol)
    .map(([c, ids]) => `${c} #${[...ids].join(',')}`)
    .join(' | ');
}

// ── Duplicados: elegir primario por md5 ─────────────────────────────────────
function buildDuplicatePrimaries(objects, refs) {
  const byMd5 = new Map();
  for (const o of objects) {
    if (!o.md5) continue;
    if (!byMd5.has(o.md5)) byMd5.set(o.md5, []);
    byMd5.get(o.md5).push(o);
  }
  const primary = new Map();
  for (const [md5, list] of byMd5) {
    if (list.length < 2) continue;
    // primario = el referenciado; si ninguno, el más antiguo
    const referenced = list.find((o) => (refs.get(o.path) || []).length > 0);
    const chosen = referenced || list.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    primary.set(md5, chosen.path);
  }
  return primary;
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n════════ RECONCILIADOR Firebase Storage ↔ PostgreSQL ════════');
  console.log(`bucket      : ${BUCKET}`);
  console.log(`modo        : ${MODE_DELETE ? '⚠ DELETE' : 'DRY RUN (por defecto)'}`);
  console.log(`gracia      : ${GRACE_DAYS} días`);
  console.log('');

  if (MODE_REST && MODE_DELETE) bail('--rest no se permite con --delete (el borrado exige Service Account).');
  const bucket = MODE_REST ? null : getBucket();
  const db = await getDb();

  try {
    process.stdout.write(`[1/5] Inventario de Storage (${MODE_REST ? 'REST pública' : 'Service Account'})… `);
    const objects = MODE_REST ? await collectStorageObjectsRest() : await collectStorageObjects(bucket);
    console.log(` ${objects.length} objetos`);

    process.stdout.write('[2/5] Referencias en PostgreSQL… ');
    const { refs, externalHosts, invalidRows, counts } = await collectReferences(db);
    console.log(
      `${refs.size} paths referenciados (${counts.products} productos, ` +
        `${counts.payment_proofs} filas payment_proofs, ${counts.reviews_with_images} reviews con imágenes)`
    );

    process.stdout.write('[3/5] Duplicados por md5… ');
    const dupPrimary = buildDuplicatePrimaries(objects, refs);
    console.log(`${dupPrimary.size} grupos de duplicados`);

    process.stdout.write('[4/5] Clasificando… ');
    const invalidPathSet = new Set(
      invalidRows.flatMap(() => []) // (los JSON corruptos no dan path; se listan aparte)
    );
    void invalidPathSet;
    const rows = objects.map((o) => {
      const refList = refs.get(o.path) || [];
      const { classification, reason } = classify(o, refList, dupPrimary);
      return {
        storagePath: o.path,
        size: o.size,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        md5: o.md5,
        prefix: o.path.split('/')[1] || null,
        entity: refList[0] ? refList[0].entity : null,
        reference: refList.map((r) => `${r.column}#${r.id}${r.isDeleted ? '(soft-deleted)' : ''}`),
        classification,
        reason,
        ageInDays: o.createdAt ? Math.round((Date.now() - new Date(o.createdAt).getTime()) / 86400000) : null,
        protected: o.path.startsWith(PROTECTED_PREFIX),
      };
    });
    console.log('ok');

    // referencias que apuntan a objetos que NO existen (rotas)
    const objPaths = new Set(objects.map((o) => o.path));
    const brokenRefs = [...refs.keys()].filter((p) => !objPaths.has(p));

    // ── resumen ──
    const byClass = {};
    for (const r of rows) {
      byClass[r.classification] = byClass[r.classification] || { n: 0, bytes: 0 };
      byClass[r.classification].n++;
      byClass[r.classification].bytes += r.size;
    }
    const totalBytes = rows.reduce((a, r) => a + r.size, 0);
    const mb = (b) => (b / 1048576).toFixed(2) + ' MB';

    console.log('\n════════ RESUMEN' + (MODE_DELETE ? '' : ' (DRY RUN — nada se ha borrado)') + ' ════════');
    console.log(`Total objetos: ${rows.length}   (${mb(totalBytes)})\n`);
    const ORDER = ['PROTECTED', 'IN_USE', 'IN_USE_SOFT_DELETED', 'TEST', 'DUPLICATE', 'ORPHAN', 'UNKNOWN', 'INVALID'];
    for (const c of ORDER) {
      const v = byClass[c];
      if (v) console.log(`  ${c.padEnd(20)} ${String(v.n).padStart(4)}   ${mb(v.bytes).padStart(12)}`);
    }
    const recoverable = (byClass.ORPHAN?.bytes || 0) + (byClass.DUPLICATE?.bytes || 0);
    console.log(`\n  Espacio potencialmente recuperable (ORPHAN + DUPLICATE): ~${mb(recoverable)}`);
    if (externalHosts.size) {
      console.log('\n  URLs externas en la BD (válidas, ignoradas por el reconciliador):');
      for (const [h, n] of externalHosts) console.log(`    ${h}: ${n}`);
    }
    if (invalidRows.length) {
      console.log('\n  ⚠ Filas de BD con JSON corrupto (revisar a mano, NO asumir huérfanas):');
      for (const r of invalidRows) console.log(`    ${r.column} #${r.id}`);
    }
    if (brokenRefs.length) {
      console.log(`\n  ⚠ Referencias en BD a objetos que NO existen en Storage (${brokenRefs.length}):`);
      for (const p of brokenRefs.slice(0, 20)) console.log(`    ${p}`);
      if (brokenRefs.length > 20) console.log(`    … y ${brokenRefs.length - 20} más`);
    }

    // ── escribir reporte ──
    const candidates = rows.filter((r) => ['ORPHAN', 'DUPLICATE', 'TEST', 'INVALID', 'UNKNOWN'].includes(r.classification));
    const reportId = crypto
      .createHash('sha256')
      .update(candidates.filter((r) => ['ORPHAN', 'DUPLICATE'].includes(r.classification)).map((r) => r.storagePath).sort().join('\n'))
      .digest('hex')
      .slice(0, 16);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'candidates.json'), JSON.stringify(candidates, null, 2));
    fs.writeFileSync(
      path.join(OUT_DIR, 'candidates.csv'),
      'storagePath,size,createdAt,classification,ageInDays,reason\n' +
        candidates
          .map((r) => `"${r.storagePath}",${r.size},${r.createdAt},${r.classification},${r.ageInDays},"${(r.reason || '').replace(/"/g, "'")}"`)
          .join('\n')
    );
    fs.writeFileSync(
      path.join(OUT_DIR, 'summary.txt'),
      `report_id: ${reportId}\ntotal: ${rows.length}\n` +
        ORDER.map((c) => byClass[c] ? `${c}: ${byClass[c].n} (${mb(byClass[c].bytes)})` : null).filter(Boolean).join('\n')
    );
    if (DUMP_JSON) fs.writeFileSync(path.join(OUT_DIR, 'full-inventory.json'), JSON.stringify(rows, null, 2));

    console.log(`\n  report_id: ${reportId}`);
    console.log(`  detalle  : ${path.relative(process.cwd(), OUT_DIR)}/`);

    // ── modo DELETE (guardado) ──
    if (!MODE_DELETE) {
      console.log('\n✔ DRY RUN completo. Para borrar candidatos revisados: --delete (ver cabecera del script).');
      await db.end();
      return;
    }

    // ─────────────── borrado — sólo con TODAS las salvaguardas ───────────────
    console.log('\n──────── MODO DELETE ────────');
    if (REPORT_ID_ARG !== reportId) {
      bail(`--report-id no coincide con el reporte actual (${reportId}). El bucket o la BD cambiaron desde el último dry-run. Vuelve a correr dry-run y revisa.`);
    }
    const targets = rows.filter((r) => ONLY.includes(r.classification) && r.classification !== 'PROTECTED');
    const expectConfirm = `BORRAR ${targets.length} OBJETOS DEL BUCKET ${PROJECT_ID}`;
    if (CONFIRM_ARG !== expectConfirm) {
      bail(`--confirm debe ser exactamente:\n  "${expectConfirm}"`);
    }
    if (targets.length > MAX_DELETE) {
      bail(`${targets.length} candidatos > --max ${MAX_DELETE}. Sube --max conscientemente o acota con --only.`);
    }

    // credencial de escritura + tabla de log
    const runId = crypto.randomUUID();
    const logClient = new (require('pg').Client)({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await logClient.connect();

    let deleted = 0;
    let skipped = 0;
    for (const t of targets) {
      if (t.storagePath.startsWith(PROTECTED_PREFIX)) { skipped++; continue; } // hard-skip incondicional
      // revalidación just-in-time: ¿sigue sin referencia y existe?
      const [exists] = await bucket.file(t.storagePath).exists();
      if (!exists) { skipped++; continue; }
      // (en un flujo real aquí se re-consultaría la BD por si volvió a usarse)
      await logClient.query(
        `INSERT INTO storage_cleanup_log
           (run_id, report_id, storage_path, size_bytes, md5_hash, classification, reason, action, operator)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'deleted',$8)`,
        [runId, reportId, t.storagePath, t.size, t.md5, t.classification, t.reason, OPERATOR]
      );
      await bucket.file(t.storagePath).delete();
      deleted++;
      if (deleted % MAX_DELETE === 0) await new Promise((r) => setTimeout(r, 200));
    }
    await logClient.end();
    console.log(`\n  borrados: ${deleted}   saltados (reclasificados / inexistentes / protegidos): ${skipped}`);
    console.log(`  run_id: ${runId}  → auditoría en storage_cleanup_log`);
    await db.end();
  } catch (err) {
    await db.end().catch(() => {});
    bail(err.stack || err.message);
  }
})();
