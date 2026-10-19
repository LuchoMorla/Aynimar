'use strict';
/* eslint-disable no-console */
/**
 * Vídeo vertical 9:16 a partir de las fotos REALES del producto (sin IA generativa).
 * ffmpeg vía spawn sin shell; los textos van por archivo (textfile=, expansion=none),
 * nunca dentro del filtergraph. Ver docs/VIDEO_ENGINE.md.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALLOWED_IMAGE_HOSTS = ['firebasestorage.googleapis.com', 'd39ru7awumhhs2.cloudfront.net'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FONT_FILE = path.join(__dirname, '../assets/fonts/Lato-Black.ttf');
const W = 1080, H = 1920, FPS = 30, SEG = 3.5, XF = 0.6;

function isAllowedImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.includes(u.hostname);
  } catch { return false; }
}

async function downloadImage(url, dest) {
  if (!isAllowedImageUrl(url)) throw new Error('host de imagen no permitido');
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`imagen HTTP ${r.status}`);
  if (!/^image\//.test(r.headers.get('content-type') || '')) throw new Error('la URL no es una imagen');
  if (Number(r.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('imagen demasiado grande');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('imagen demasiado grande');
  fs.writeFileSync(dest, buf);
}

// Corte por palabras para que el texto quepa en pantalla.
function wrap(text, max = 22) {
  const lines = [];
  let cur = '';
  for (const w of String(text).replace(/\s+/g, ' ').trim().split(' ')) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // Prioridad baja: la API comparte CPU con ffmpeg (numReplicas=1).
    try { os.setPriority(p.pid, 10); } catch { /* sin permiso o proceso ya terminado */ }
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.split('\n').slice(-3).join(' | ')}`)); });
  });
}

/**
 * @param {object} o
 * @param {string[]} o.images   URLs de fotos reales (2–6), solo hosts permitidos
 * @param {{text:string, from:number, to:number, pos:'top'|'bottom', size?:number}[]} o.texts  from/to en segundos
 * @param {string} o.outPath
 */
async function renderProductVideo({ images, texts, outPath, fontFile = FONT_FILE, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', timeoutMs = 120000 }) {
  const imgs = images.slice(0, 6);
  if (imgs.length < 2) throw new Error('se necesitan al menos 2 imágenes reales');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  try {
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    for (let i = 0; i < imgs.length; i++) {
      const f = path.join(dir, `img${i}`);
      await downloadImage(imgs[i], f);
      args.push('-i', f);
    }
    const frames = Math.round(SEG * FPS);
    const parts = imgs.map((_, i) =>
      `[${i}:v]format=rgb24,split[a${i}][b${i}];` +
      `[a${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=brightness=-0.12[bg${i}];` +
      `[b${i}]scale=${W - 80}:${H - 640}:force_original_aspect_ratio=decrease[fg${i}];` +
      `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,` +
      `zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p,` +
      `fade=t=in:st=0:d=${XF / 2},fade=t=out:st=${SEG - XF / 2}:d=${XF / 2}[s${i}]`);
    // ponytail: fundido a negro + concat (vale en ffmpeg 4.2); xfade (≥4.3) si se quiere fundido cruzado.
    parts.push(`${imgs.map((_, i) => `[s${i}]`).join('')}concat=n=${imgs.length}:v=1:a=0[cat]`);
    const total = SEG * imgs.length;
    const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const draws = texts.map((t, k) => {
      const tf = path.join(dir, `t${k}.txt`);
      fs.writeFileSync(tf, wrap(t.text, t.size && t.size > 80 ? 14 : 22));
      const y = t.pos === 'top' ? 'h*0.09' : 'h*0.80-text_h/2';
      // expansion=none: '%' del texto no se interpreta como %{expr}.
      return `drawtext=fontfile='${esc(fontFile)}':textfile='${esc(tf)}':expansion=none:fontsize=${t.size || 64}:fontcolor=white:line_spacing=12:` +
        `box=1:boxcolor=black@0.55:boxborderw=28:x=(w-text_w)/2:y=${y}:enable='between(t,${Number(t.from)},${Math.min(Number(t.to), total)})'`;
    });
    parts.push(`[cat]${draws.join(',') || 'null'}[v]`);
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', parts.join(';'), '-map', '[v]', '-map', `${imgs.length}:a`,
      '-t', total.toFixed(2), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-maxrate', '6M', '-bufsize', '12M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
      '-threads', '2', '-movflags', '+faststart', outPath);
    await run(ffmpegPath, args, timeoutMs);
    return { filePath: outPath, bytes: fs.statSync(outPath).size, durationS: total };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Plantillas ───────────────────────────────────────────────────────────────
// Solo datos de BD (nombre, precio, nº de fotos) + un beneficio escrito por el
// dueño. Nada sale de un LLM. Tiempos como fracción de la duración total.
const FORBIDDEN_CLAIMS = /env[ií]o\s+gratis|garant[ií]a|contra\s*entrega|original/i;
const VARIANTS = {
  v1: { maxImages: 4, texts: (d) => [ // "Precio primero"
    { text: `¿${d.name} a solo ${d.price}?`, from: 0, to: 0.22, pos: 'top', size: 66 },
    { text: d.benefit, from: 0.22, to: 0.66, pos: 'bottom' },
    { text: d.price, from: 0.66, to: 0.82, pos: 'bottom', size: 130 },
    { text: 'Pídelo de una en aynimar.com', from: 0.82, to: 1, pos: 'bottom', size: 70 },
  ] },
  v2: { maxImages: 5, texts: (d) => [ // "Míralo de cerca"
    { text: `Mira bien este ${d.name}`, from: 0, to: 0.17, pos: 'top', size: 66 },
    { text: d.benefit, from: 0.17, to: 0.45, pos: 'bottom' },
    { text: 'Fotos reales del producto', from: 0.45, to: 0.7, pos: 'bottom' },
    { text: `Precio: ${d.price}`, from: 0.7, to: 0.85, pos: 'bottom', size: 110 },
    { text: 'Pídelo en aynimar.com', from: 0.85, to: 1, pos: 'bottom', size: 70 },
  ] },
  v3: { maxImages: 6, texts: (d) => [ // "Antes de comprar"
    { text: `Antes de comprar tu ${d.name}, mira esto`, from: 0, to: 0.14, pos: 'top', size: 66 },
    { text: d.benefit, from: 0.14, to: 0.45, pos: 'bottom' },
    { text: `${d.nPhotos} fotos reales para que lo veas bien`, from: 0.45, to: 0.72, pos: 'bottom' },
    { text: `${d.price} y listo`, from: 0.72, to: 0.86, pos: 'bottom', size: 110 },
    { text: 'Chévere, ¿no? Encuéntralo en aynimar.com', from: 0.86, to: 1, pos: 'bottom', size: 70 },
  ] },
};

function shortName(name, max = 40) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ') > 15 ? cut.lastIndexOf(' ') : max).trim();
}

/** Textos con tiempos absolutos para renderProductVideo. Lanza si el beneficio no es válido. */
function buildTexts(variant, { name, price, benefit, nPhotos }) {
  const v = VARIANTS[variant];
  if (!v) throw new Error(`variante desconocida: ${variant}`);
  const b = String(benefit || '').replace(/\s+/g, ' ').trim();
  if (b.length < 3 || b.length > 60) throw new Error('el beneficio debe tener entre 3 y 60 caracteres');
  if (FORBIDDEN_CLAIMS.test(b)) throw new Error('el beneficio contiene una afirmación no permitida (envío gratis/garantía/contra entrega/original)');
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) throw new Error('precio inválido');
  const total = SEG * nPhotos;
  const data = { name: shortName(name), price: `$${p.toFixed(2)}`, benefit: b, nPhotos };
  return v.texts(data).map((t) => ({ ...t, from: +(t.from * total).toFixed(2), to: t.to === 1 ? 999 : +(t.to * total).toFixed(2) }));
}

/** [image, ...images] sin duplicados y solo de hosts permitidos. */
function productImages(product) {
  let extra = product.images;
  if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch { extra = []; } }
  return [...new Set([product.image, ...(Array.isArray(extra) ? extra : [])])].filter((u) => typeof u === 'string' && isAllowedImageUrl(u));
}

const DEFAULT_STORE_BASE_URL = 'https://www.aynimar.com';
// Motor ffmpeg local con fotos reales: sin coste variable por pieza.
const FFMPEG_PRODUCTION_COST_USD = 0;

/** STORE_BASE_URL (p.ej. la tienda de staging) validada: https, sin query/hash/credenciales, sin barra final. */
function storeBaseUrl(env = process.env) {
  const raw = env.STORE_BASE_URL;
  if (!raw) return DEFAULT_STORE_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && !u.search && !u.hash && !u.username && !u.password) return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch { /* inválida: se usa la de por defecto */ }
  console.warn('[Video] STORE_BASE_URL inválida (debe ser https://host[/ruta]); se usa la tienda por defecto.');
  return DEFAULT_STORE_BASE_URL;
}

function storeLink(productId, { network = 'instagram', campaign, ref }, env = process.env) {
  const q = new URLSearchParams({ utm_source: network, utm_medium: 'organic', utm_campaign: campaign, utm_content: ref });
  return `${storeBaseUrl(env)}/store/${encodeURIComponent(productId)}?${q}`;
}

/** Texto listo para copiar en la red (kit de publicación manual). Solo datos de BD + beneficio del dueño. */
function socialCaption({ name, price, benefit, link }) {
  const b = String(benefit || '').replace(/\s+/g, ' ').trim();
  return `${shortName(name)}\n${b}\nPrecio: $${Number(price).toFixed(2)} · pagas al recibir.\nPídelo en aynimar.com 👉 ${link}`;
}

/** ref opaco ≤32 [A-Za-z0-9_-] para callback_data. */
function newRef(productId) {
  return `v${productId}x${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Envía el mp4 a Telegram para revisión y registra la fila pending (F2).
 * Si la BD falla, el vídeo ya está en el chat: se avisa al admin y no se lanza
 * (no se reintenta el envío). Lanza solo si Telegram no acepta el vídeo.
 */
async function sendForReview({ file, product, variant, benefit, network, ref }) {
  const link = storeLink(product.id, { network, campaign: `video_${variant}`, ref });
  const caption = `Vídeo ${variant.toUpperCase()} para revisión\n${shortName(product.name)} · $${Number(product.price).toFixed(2)}\nBeneficio: ${String(benefit).replace(/\s+/g, ' ').trim()}\nRef: ${ref}\n${link}`;
  const { sendTelegramVideo } = require('../utils/telegramNotify');
  const tg = await sendTelegramVideo(file, caption, ref);
  if (!tg.ok) throw new Error(`Telegram no aceptó el vídeo ${ref}`);
  console.log(`[Video] ${ref} enviado a revisión file_id=${tg.fileId}`);
  try {
    await require('../Services/creativeReviewService').recordPending({
      ref, productId: product.id, variant, network, utmLink: link,
      caption: socialCaption({ name: product.name, price: product.price, benefit, link }),
      telegramFileId: tg.fileId, telegramMessageId: tg.messageId,
      productionCostUsd: FFMPEG_PRODUCTION_COST_USD,
    });
  } catch (err) {
    console.error(`[Video] ${ref} no se pudo registrar la revisión: ${err.name}`);
    const { sendTelegramNotification } = require('../utils/telegramNotify');
    await sendTelegramNotification(`⚠️ El vídeo ${ref} se envió pero no se pudo registrar su revisión: sus botones no funcionarán. Genera de nuevo la pieza.`);
  }
  return tg;
}

/**
 * Lee el producto, renderiza y (si send) lo envía a Telegram para revisión.
 * Sin outPath el mp4 va a un temporal que se borra al terminar.
 */
async function createProductVideo({ productId, variant, benefit, network = 'instagram', ref = newRef(productId), outPath, send = true }) {
  const { models } = require('../libs/sequelize');
  const product = await models.Product.findByPk(productId, { attributes: ['id', 'name', 'price', 'image', 'images'] });
  if (!product) throw new Error(`producto ${productId} no encontrado`);
  const images = productImages(product).slice(0, VARIANTS[variant]?.maxImages || 0);
  if (images.length < 2) throw new Error(`producto ${productId}: menos de 2 imágenes reales en hosts permitidos`);
  const texts = buildTexts(variant, { name: product.name, price: product.price, benefit, nPhotos: images.length });

  const file = outPath || path.join(os.tmpdir(), `video-${ref}.mp4`);
  try {
    const t0 = Date.now();
    const r = await renderProductVideo({ images, texts, outPath: file });
    console.log(`[Video] ${ref} producto=${productId} ${variant} ${(r.bytes / 1e6).toFixed(1)}MB ${r.durationS}s render=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!send) return { ...r, ref };
    const tg = await sendForReview({ file, product, variant, benefit, network, ref });
    return { ...r, ref, fileId: tg.fileId };
  } finally {
    if (!outPath) fs.rmSync(file, { force: true });
  }
}

module.exports = {
  renderProductVideo, createProductVideo, buildTexts, productImages, storeLink, storeBaseUrl, newRef, socialCaption, sendForReview,
  wrap, shortName, isAllowedImageUrl, ALLOWED_IMAGE_HOSTS, VARIANTS, FONT_FILE,
};
