/* eslint-disable no-console */
/**
 * Valida storage.rules contra el emulador de Firebase Storage con el SDK real
 * (mismo camino que usa el frontend: uploadBytes / getDownloadURL / deleteObject).
 *
 * USO:  npm run storage:emulator:test
 *   (arráncalo dentro del emulador:)
 *   npx firebase emulators:exec --only storage --project demo-aynimar \
 *       'node scripts/storage-rules-emulator-test.mjs'
 *
 * Requiere JDK 21+ (lo exige el runtime de reglas de firebase-tools ≥ 14).
 * Salida: exit 0 si todos los casos pasan.
 */
import { initializeApp } from 'firebase/app';
import {
  getStorage, connectStorageEmulator, ref, uploadBytes, getDownloadURL,
  deleteObject, getBytes, listAll,
} from 'firebase/storage';

const app = initializeApp({ projectId: 'demo-aynimar', storageBucket: 'demo-aynimar.appspot.com', apiKey: 'x' });
const storage = getStorage(app);
connectStorageEmulator(storage, '127.0.0.1', 9199);

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const txt = new TextEncoder().encode('definitely not an image');
const big8 = new Uint8Array(8 * 1024 * 1024 + 10); big8.set(jpeg);
const big10 = new Uint8Array(10 * 1024 * 1024 + 10); big10.set(png);

let pass = 0, fail = 0;
async function t(desc, expect, fn) {
  let got;
  try { await fn(); got = 'ok'; }
  catch (e) { got = e && e.code === 'storage/unauthorized' ? 'deny' : `ERR:${(e && e.code) || e}`; }
  const ok = got === expect;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${got}${ok ? '' : ' esperaba ' + expect}]  ${desc}`);
  ok ? pass++ : fail++;
}
const put = (p, d, ct) => uploadBytes(ref(storage, p), d, ct ? { contentType: ct } : undefined);
const get = (p) => getDownloadURL(ref(storage, p));
const read = (p) => getBytes(ref(storage, p));
const del = (p) => deleteObject(ref(storage, p));
const ls = (p) => listAll(ref(storage, p));

console.log('== PAYMENT-PROOFS ==');
await t('create JPEG válido <8MB           -> permitido', 'ok', () => put('images/payment-proofs/500/a.jpg', jpeg, 'image/jpeg'));
await t('create PNG válido                 -> permitido', 'ok', () => put('images/payment-proofs/500/b.png', png, 'image/png'));
await t('create WebP válido                -> permitido', 'ok', () => put('images/payment-proofs/500/c.webp', webp, 'image/webp'));
await t('getDownloadURL de a.jpg           -> permitido', 'ok', () => get('images/payment-proofs/500/a.jpg'));
await t('getBytes de a.jpg                 -> permitido', 'ok', () => read('images/payment-proofs/500/a.jpg'));
await t('OVERWRITE a.jpg (mismo path)      -> RECHAZADO', 'deny', () => put('images/payment-proofs/500/a.jpg', jpeg, 'image/jpeg'));
await t('OVERWRITE a.jpg con otro contenido-> RECHAZADO', 'deny', () => put('images/payment-proofs/500/a.jpg', png, 'image/png'));
await t('delete a.jpg desde cliente        -> RECHAZADO', 'deny', () => del('images/payment-proofs/500/a.jpg'));
await t('listAll carpeta de la orden       -> RECHAZADO', 'deny', () => ls('images/payment-proofs/500'));
await t('create >8MB                       -> RECHAZADO', 'deny', () => put('images/payment-proofs/501/big.jpg', big8, 'image/jpeg'));
await t('create MIME text/plain            -> RECHAZADO', 'deny', () => put('images/payment-proofs/502/x.txt', txt, 'text/plain'));
await t('create sin contentType (octet)    -> RECHAZADO', 'deny', () => put('images/payment-proofs/502/y.bin', txt));

console.log('== CATÁLOGO ==');
await t('products create JPEG              -> permitido', 'ok', () => put('images/products/999-0/p.jpg', jpeg, 'image/jpeg'));
await t('products getDownloadURL           -> permitido', 'ok', () => get('images/products/999-0/p.jpg'));
await t('products OVERWRITE (permitido)    -> permitido', 'ok', () => put('images/products/999-0/p.jpg', png, 'image/png'));
await t('products delete cliente (deleteFile) -> permitido', 'ok', () => del('images/products/999-0/p.jpg'));
await t('categories create WebP            -> permitido', 'ok', () => put('images/categories/7/c.webp', webp, 'image/webp'));
await t('business create PNG               -> permitido', 'ok', () => put('images/business/3/b.png', png, 'image/png'));
await t('variant-images create             -> permitido', 'ok', () => put('images/variant-images/123/v.jpg', jpeg, 'image/jpeg'));
await t('wastes create                     -> permitido', 'ok', () => put('images/wastes/4/w.png', png, 'image/png'));
await t('getBytes de imagen de catálogo    -> permitido', 'ok', () => read('images/categories/7/c.webp'));
await t('listAll products (endurecido: sin enumeración) -> RECHAZADO', 'deny', () => ls('images/products'));
await t('products create >10MB             -> RECHAZADO', 'deny', () => put('images/products/999-9/huge.png', big10, 'image/png'));
await t('products create MIME text/plain   -> RECHAZADO', 'deny', () => put('images/products/999-9/x.txt', txt, 'text/plain'));
await t('products create sin contentType   -> RECHAZADO', 'deny', () => put('images/products/999-9/y.bin', txt));

console.log('== FUERA DE CONTRATO ==');
await t('objeto en images/ raíz (depth 2)  -> RECHAZADO', 'deny', () => put('images/rogue.jpg', jpeg, 'image/jpeg'));
await t('objeto en raíz del bucket         -> RECHAZADO', 'deny', () => put('rogue.jpg', jpeg, 'image/jpeg'));
await t('payment-proofs anidado depth 5    -> RECHAZADO', 'deny', () => put('images/payment-proofs/1/sub/deep.jpg', jpeg, 'image/jpeg'));
await t('objeto suelto images/products/x (depth 3) -> RECHAZADO', 'deny', () => put('images/products/loose.jpg', jpeg, 'image/jpeg'));
await t('objeto anidado images/products/a/b/c (depth 5) -> RECHAZADO', 'deny', () => put('images/products/a/b/c.jpg', jpeg, 'image/jpeg'));

console.log(`\nRESULTADO: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
