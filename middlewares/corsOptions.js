'use strict';

// ── CORS — Fase A (A4) ────────────────────────────────────────────────────────
// Whitelist explícita de los orígenes REALES de producción. Nada de dominios
// de preview de Vercel ni localhost como origen de producción.
//   - Tienda:    https://www.aynimar.com  (+ apex)
//   - Dashboard: https://circular-merchant.aynimar.com
// En entorno no-productivo se aceptan además localhost/127.0.0.1 (cualquier
// puerto) para desarrollo. Orígenes extra se pueden añadir sin tocar código
// con CORS_EXTRA_ORIGINS="https://a.com,https://b.com".
const PROD_ORIGINS = [
  'https://www.aynimar.com',
  'https://aynimar.com',
  'https://circular-merchant.aynimar.com',
];

const EXTRA_ORIGINS = (process.env.CORS_EXTRA_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([...PROD_ORIGINS, ...EXTRA_ORIGINS]);
const IS_PROD = process.env.NODE_ENV === 'production';

const corsOptions = {
  origin: (origin, callback) => {
    // Sin Origin = petición servidor-a-servidor / curl / health / Dropi → permitido.
    if (!origin) return callback(null, true);

    const clean = origin.replace(/\/$/, '');
    if (ALLOWED_ORIGINS.has(clean)) return callback(null, true);

    if (!IS_PROD && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)) {
      return callback(null, true);
    }

    // No permitido → sin cabeceras CORS (el navegador bloquea). Antes se lanzaba un
    // Error que el errorHandler convertía en 500 (también en cada preflight).
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'api'],
  credentials: true,
};

module.exports = { corsOptions, ALLOWED_ORIGINS };
