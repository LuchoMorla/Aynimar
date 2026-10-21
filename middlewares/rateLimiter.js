const rateLimit = require('express-rate-limit');
const log = require('../libs/logger');

// 100 requests per 15 min per IP — applied globally before all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Hub multiempresa (/api/v1/hub/handle): una sola IP; lo protegen la firma HMAC,
  // su limitador de firmas inválidas y el tope por remitente (routes/hubRouter.js).
  skip: (req) => req.path === '/health' || req.path === '/api/v1/hub/handle',
  handler: (req, res) => {
    log.warn('rate_limit_general', {
      ip: (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress,
      path: req.path,
    });
    res.status(429).json({ message: 'Demasiadas solicitudes. Intenta en 15 minutos.' });
  },
});

// 10 requests per 15 min per IP — applied only to auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    log.warn('rate_limit_auth', {
      ip: (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress,
      path: req.path,
    });
    res.status(429).json({ message: 'Demasiados intentos. Intenta en 15 minutos.' });
  },
});

// 5 requests per 15 min per IP — POST /orders/track/lookup (pedido + contacto → token).
// ponytail: en memoria por réplica; Redis store si se escala a varias réplicas.
const trackLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    log.warn('rate_limit_track_lookup', {
      ip: (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress,
    });
    res.status(429).json({ message: 'Demasiados intentos. Intenta en 15 minutos.' });
  },
});

// …y además 5 por pedido / 15 min, venga de la IP que venga (frena el reparto entre IPs).
const trackLookupOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `track-order:${Number(req.body?.orderId) || 0}`,
  handler: (req, res) => {
    log.warn('rate_limit_track_lookup_order', {});
    res.status(429).json({ message: 'Demasiados intentos. Intenta en 15 minutos.' });
  },
});

module.exports = { generalLimiter, authLimiter, trackLookupLimiter, trackLookupOrderLimiter };
