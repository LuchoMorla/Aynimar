'use strict';
/* eslint-disable no-console */
/**
 * Render manual de un vídeo de producto (fotos reales, sin IA generativa).
 *
 * Usage:
 *   node scripts/render-product-video.js <productId> [v1|v2|v3] "<beneficio>" [--out archivo.mp4]
 *
 * Sin --out: renderiza y lo envía a Telegram (admin) para revisión; borra el temporal.
 * Con --out: solo renderiza a ese archivo (no envía nada).
 * Necesita DATABASE_URL y ffmpeg (FFMPEG_PATH o 'ffmpeg' en PATH).
 */
require('dotenv').config();
const { createProductVideo, VARIANTS } = require('../integrations/videoService');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : undefined;
const [productId, maybeVariant, ...rest] = argv;
const variant = VARIANTS[maybeVariant] ? maybeVariant : 'v1';
const benefit = (VARIANTS[maybeVariant] ? rest : [maybeVariant, ...rest]).filter(Boolean).join(' ');

if (!/^\d+$/.test(productId || '') || !benefit || (outIdx >= 0 && !outPath)) {
  console.error('Uso: node scripts/render-product-video.js <productId> [v1|v2|v3] "<beneficio>" [--out archivo.mp4]');
  process.exit(2);
}

createProductVideo({ productId: Number(productId), variant, benefit, outPath, send: !outPath })
  .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
  .catch((err) => { console.error('ERROR', err.message); process.exit(1); });
