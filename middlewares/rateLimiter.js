const rateLimit = require('express-rate-limit');
const log = require('../libs/logger');

// 100 requests per 15 min per IP — applied globally before all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
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

module.exports = { generalLimiter, authLimiter };
