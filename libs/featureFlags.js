'use strict';

// Feature flags driven by Railway environment variables.
// Toggle any flag without redeploy: set the env var to 'true' or 'false' in
// Railway dashboard → Variables, then redeploy (or use Railway's live env update).
//
// Convention: FLAG_<UPPER_SNAKE_CASE> = 'true' | 'false'
// Default is always false (off) — flags must be explicitly enabled.

const FLAGS = {
  nueva_logica_pago:      process.env.FLAG_NUEVA_LOGICA_PAGO      === 'true',
  neuro_copy_v2:          process.env.FLAG_NEURO_COPY_V2           === 'true',
  dropi_retry_v2:         process.env.FLAG_DROPI_RETRY_V2          === 'true',
  cart_recovery_email:    process.env.FLAG_CART_RECOVERY_EMAIL     === 'true',
  woocommerce_mirror:     process.env.FLAG_WOOCOMMERCE_MIRROR      === 'true',
};

/**
 * Check if a feature flag is active.
 * @param {keyof FLAGS} flag
 * @returns {boolean}
 */
function isEnabled(flag) {
  if (!(flag in FLAGS)) {
    // Unknown flag — fail closed (safe default)
    return false;
  }
  return FLAGS[flag] === true;
}

module.exports = { isEnabled, FLAGS };
