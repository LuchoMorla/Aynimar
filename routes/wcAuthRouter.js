'use strict';

/**
 * WooCommerce OAuth 1.0 Authorization Mock
 *
 * Dropi uses the standard WooCommerce wc-auth flow to connect to stores.
 * Since we are not a real WooCommerce installation, this router intercepts
 * the authorization request and completes the handshake automatically.
 *
 * Flow:
 *   1. Admin in Dropi panel clicks "Connect store → https://www.aynimar.com"
 *   2. Dropi redirects admin browser to:
 *        GET /store/wc-auth/v1/authorize?app_name=Dropi&scope=read_write
 *                                        &user_id=<dropi_uid>
 *                                        &return_url=<dropi_return>
 *                                        &callback_url=<dropi_callback>
 *   3. This handler validates the request, POSTs our WC credentials to
 *      Dropi's callback_url (server-to-server), then redirects the admin
 *      browser back to Dropi with ?success=1.
 *
 * Mount: app.use('/store/wc-auth/v1', wcAuthRouter)   ← set in routes/index.js
 *
 * Security:
 *   - Only accepts app_name === 'Dropi'
 *   - callback_url must be on api.dropi.ec (prevents SSRF to arbitrary hosts)
 *   - No JWT required — this is a browser-redirect OAuth flow, not an API call
 */

const express = require('express');
const axios   = require('axios');

const router = express.Router();

const ALLOWED_APP_NAME      = 'Dropi';
const ALLOWED_CALLBACK_HOST = 'api.dropi.ec';

router.get('/authorize', async (req, res) => {
  const { app_name, scope, user_id, return_url, callback_url } = req.query;

  // ── Validate required params ──────────────────────────────────────────────
  if (!app_name || !callback_url || !return_url) {
    return res.status(400).send('Bad Request: missing OAuth parameters (app_name, callback_url, return_url required).');
  }

  if (app_name !== ALLOWED_APP_NAME) {
    console.warn(`[WC OAuth] Rejected request from unknown app: "${app_name}"`);
    return res.status(403).send('Forbidden: only the Dropi application is authorized.');
  }

  // ── Security: block SSRF — only POST to Dropi's own API domain ───────────
  let parsedCallback;
  try {
    parsedCallback = new URL(callback_url);
  } catch {
    return res.status(400).send('Bad Request: callback_url is not a valid URL.');
  }

  if (parsedCallback.hostname !== ALLOWED_CALLBACK_HOST) {
    console.warn(`[WC OAuth] SSRF attempt blocked — callback_url host: "${parsedCallback.hostname}"`);
    return res.status(403).send('Forbidden: callback_url host not allowed.');
  }

  // ── Read WC credentials ───────────────────────────────────────────────────
  // These are stored in Railway env vars and must match the Business row that
  // woocommerceMirror.js looks up in wooBasicAuth (wooConsumerKey / wooConsumerSecret).
  const consumerKey    = process.env.WOO_CONSUMER_KEY;
  const consumerSecret = process.env.WOO_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    console.error('[WC OAuth] WOO_CONSUMER_KEY or WOO_CONSUMER_SECRET not set in Railway.');
    return res.status(500).send('Store credentials not configured. Contact the administrator.');
  }

  // ── POST credentials to Dropi (server-to-server) ─────────────────────────
  // WooCommerce sends this payload to the callback URL so the connecting app
  // can authenticate against the store in future requests.
  const callbackPayload = {
    key_id:          1,
    user_id:         user_id ? Number(user_id) : 0,
    consumer_key:    consumerKey,
    consumer_secret: consumerSecret,
    key_permissions: scope === 'read' ? 'read' : 'read_write',
  };

  try {
    console.log(`[WC OAuth] POSTing credentials to Dropi callback: ${callback_url}`);
    const cbRes = await axios.post(callback_url, callbackPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    console.log(`[WC OAuth] Dropi callback responded: ${cbRes.status}`);
  } catch (err) {
    // Log but do not block the flow — redirect anyway so the admin is not stuck.
    console.error(`[WC OAuth] Dropi callback failed: ${err.response?.status ?? err.message}`);
  }

  // ── Redirect admin browser back to Dropi with success=1 ──────────────────
  let redirectTarget;
  try {
    redirectTarget = new URL(return_url);
    redirectTarget.searchParams.set('success', '1');
  } catch {
    return res.status(400).send('Bad Request: return_url is not a valid URL.');
  }

  console.log(`[WC OAuth] Redirecting to: ${redirectTarget}`);
  return res.redirect(302, redirectTarget.toString());
});

module.exports = router;
