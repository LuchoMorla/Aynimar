'use strict';

/**
 * WooCommerce OAuth 1.0 Authorization Mock — Dropi Integration
 *
 * Dropi's store connector uses the standard WooCommerce wc-auth flow.
 * This router completes the handshake on behalf of www.aynimar.com.
 *
 * Request from Dropi (browser redirect):
 *   GET /store/wc-auth/v1/authorize
 *       ?app_name=Dropi
 *       &scope=read_write
 *       &user_id=75551
 *       &return_url=https://app.dropi.ec/dashboard/shop/edit?id=54329
 *       &callback_url=https://api.dropi.ec/api/shops/woocomerceoAuth/?shop_id=54329
 *
 * Handler flow:
 *   1. Validate app_name === 'Dropi'
 *   2. Validate callback_url is on api.dropi.ec (SSRF guard)
 *   3. Validate shop_id in callback_url matches DROPI_SHOP_ID env var
 *   4. POST FRONT_WOO_CONSUMER_KEY + FRONT_WOO_CONSUMER_SECRET to callback_url
 *   5. Redirect browser → return_url?success=1
 *
 * Required Railway env vars:
 *   FRONT_WOO_CONSUMER_KEY    — WC consumer key for www.aynimar.com ↔ Dropi
 *   FRONT_WOO_CONSUMER_SECRET — WC consumer secret
 *   DROPI_SHOP_ID             — Dropi shop ID tied to aynimar.com (e.g. 54329)
 */

const express = require('express');
const axios   = require('axios');

const router = express.Router();

const ALLOWED_APP_NAME      = 'Dropi';
const ALLOWED_CALLBACK_HOST = 'api.dropi.ec';

router.get('/authorize', async (req, res) => {
  const { app_name, scope, user_id, return_url, callback_url } = req.query;

  console.log(`[WC OAuth] Incoming request — app_name="${app_name}" user_id="${user_id}"`);

  // ── 1. Required params ────────────────────────────────────────────────────
  if (!app_name || !callback_url || !return_url) {
    console.warn('[WC OAuth] Rejected: missing required parameters.');
    return res.status(400).send('Bad Request: app_name, callback_url, and return_url are required.');
  }

  // ── 2. App identity check ─────────────────────────────────────────────────
  if (app_name !== ALLOWED_APP_NAME) {
    console.warn(`[WC OAuth] Rejected: unknown app_name="${app_name}"`);
    return res.status(403).send('Forbidden: only the Dropi application is authorized.');
  }

  // ── 3. SSRF guard — callback must be on api.dropi.ec ─────────────────────
  let parsedCallback;
  try {
    parsedCallback = new URL(callback_url);
  } catch {
    return res.status(400).send('Bad Request: callback_url is not a valid URL.');
  }

  if (parsedCallback.hostname !== ALLOWED_CALLBACK_HOST) {
    console.warn(`[WC OAuth] SSRF blocked — callback_url host="${parsedCallback.hostname}"`);
    return res.status(403).send('Forbidden: callback_url host not allowed.');
  }

  // ── 4. Shop identity validation ───────────────────────────────────────────
  // Dropi embeds shop_id in the callback_url — validate it matches our store.
  const incomingShopId = parsedCallback.searchParams.get('shop_id');
  const expectedShopId = process.env.DROPI_SHOP_ID || '54329'; // aynimar.com Dropi shop ID

  if (incomingShopId && incomingShopId !== expectedShopId) {
    console.warn(`[WC OAuth] Shop ID mismatch — got "${incomingShopId}", expected "${expectedShopId}"`);
    return res.status(403).send('Forbidden: shop_id does not match this store integration.');
  }

  // ── 5. Credentials — FRONT_WOO_* are the aynimar.com ↔ Dropi keys ────────
  const consumerKey    = process.env.FRONT_WOO_CONSUMER_KEY;
  const consumerSecret = process.env.FRONT_WOO_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    console.error('[WC OAuth] FRONT_WOO_CONSUMER_KEY or FRONT_WOO_CONSUMER_SECRET not set in Railway.');
    return res.status(500).send('Store credentials not configured. Set FRONT_WOO_CONSUMER_KEY and FRONT_WOO_CONSUMER_SECRET in Railway.');
  }

  // ── 6. POST credentials to Dropi (server-to-server handshake) ────────────
  // WooCommerce OAuth spec: https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication
  const callbackPayload = {
    key_id:          1,
    user_id:         user_id ? Number(user_id) : 0,
    consumer_key:    consumerKey,
    consumer_secret: consumerSecret,
    key_permissions: scope === 'read' ? 'read' : 'read_write',
  };

  console.log(`[WC OAuth] POSTing credentials to Dropi: ${callback_url}`);
  console.log(`[WC OAuth] shop_id="${incomingShopId}" user_id="${user_id}" scope="${scope}"`);

  try {
    const cbRes = await axios.post(callback_url, callbackPayload, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 15000,
    });
    console.log(`[WC OAuth] Dropi callback accepted — HTTP ${cbRes.status} ✓`);
  } catch (err) {
    const status = err.response?.status ?? 'network error';
    console.error(`[WC OAuth] Dropi callback failed — HTTP ${status}: ${err.message}`);
    // Do not block — redirect anyway so the admin is not left on a broken page.
    // Dropi may have already persisted the credentials on their side.
  }

  // ── 7. Redirect browser → Dropi success page ─────────────────────────────
  let redirectTarget;
  try {
    redirectTarget = new URL(return_url);
    redirectTarget.searchParams.set('success', '1');
  } catch {
    return res.status(400).send('Bad Request: return_url is not a valid URL.');
  }

  console.log(`[WC OAuth] Authorization complete — redirecting to ${redirectTarget}`);
  return res.redirect(302, redirectTarget.toString());
});

module.exports = router;
