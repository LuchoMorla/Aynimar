const boom = require('@hapi/boom');
const passport = require('passport');
const { config } = require('./../config/config');

// Fase A (A3): autenticación OPCIONAL.
// Adjunta req.user si viene un JWT válido, pero NO rechaza la petición cuando
// falta o es inválido. Se usa en rutas que sirven a la vez a invitados (carrito
// guest, sin token) y a usuarios logueados, donde la autorización real se
// resuelve en el servicio según sea carrito guest o de un cliente.
function optionalAuth(req, res, next) {
  passport.authenticate('jwt', { session: false }, (err, user) => {
    if (err) return next(err);
    if (user) req.user = user;
    return next();
  })(req, res, next);
}

function checkApiKey(req, res, next) {
  const apiKey = req.headers['api'];
  if (apiKey === config.apiKey) {
    next();
  } else {
    next(boom.unauthorized());
  }
}

function checkAdminRole(req, res, next) {
  const user = req.user;
  if (user.role === 'admin') {
    next();
  } else {
    next(boom.forbidden('no tienes permiso para ejecutar esta acción'));
  }
}


function checkRoles(...roles) {
  return (req, res, next) => {
    const user = req.user;
    if (roles.includes(user.role)) {
      next();
    } else {
      next(boom.forbidden('no tienes permiso para ejecutar esta acción'));
    }
  }
}



// IDOR: admin accede a lo de cualquiera; el resto solo a lo suyo (userId = su
// sub). Si no, 404: no revela si el recurso existe. Lo usan orders y payments.
function assertUserAccess(userId, { sub, role }) {
  if (role === 'admin' || (userId != null && Number(userId) === Number(sub))) return;
  throw boom.notFound('No encontrado');
}

module.exports = { checkApiKey, checkAdminRole, checkRoles, optionalAuth, assertUserAccess }