const { Resend } = require('resend');

// Use a placeholder when key is absent so the module loads in local dev / test
// environments without a key. Real sends will fail at API call time with a
// clear error from Resend instead of crashing at startup.
const resend = new Resend(process.env.RESEND_API_KEY || 'not-configured');

module.exports = resend;
