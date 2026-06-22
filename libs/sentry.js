'use strict';
const Sentry = require('@sentry/node');

// Only initialize when DSN is set — allows local dev without Sentry configured.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.RAILWAY_DEPLOYMENT_ID || 'local',

    // Capture 100% of transactions in prod — lower to 0.2 if volume grows
    tracesSampleRate: 1.0,

    // Attach request info (IP, method, url) to every event
    sendDefaultPii: false,

    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
  });
}

module.exports = Sentry;
