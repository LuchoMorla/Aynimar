'use strict';

/**
 * Comprobación de variables que comparten /health y el aviso de deploy por Telegram.
 * DROPI_INTEGRATION_KEY solo es obligatoria con el transporte http de órdenes; el servidor entra
 * a Dropi con login propio + Cloudflare Worker (DROPI_WORKER_URL/KEY), que es lo que se comprueba.
 */
function deployHealthChecks(env = process.env) {
  const checks = {
    jwt_secret:       !!env.JWT_SECRET,
    groq_api_key:     !!(env.GROQ_API_KEY || env.GROQ_IA_KEY),
    cloudflare_worker: !!(env.DROPI_WORKER_URL && env.DROPI_WORKER_KEY),
  };
  if (env.DROPI_ORDER_TRANSPORT === 'http') checks.dropi_integration_key = !!env.DROPI_INTEGRATION_KEY;
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return { checks, missing };
}

module.exports = { deployHealthChecks };
