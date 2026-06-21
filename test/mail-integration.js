/**
 * Nodemailer Integration Test — v6 → v9 Migration Validator
 *
 * PURPOSE
 *   Run this script BEFORE and AFTER upgrading nodemailer to confirm that
 *   the SMTP transport works identically on both versions.
 *
 * USAGE
 *   SMAIL=your@gmail.com GPASS=your-app-password RMAIL=dest@email.com \
 *     node test/mail-integration.js
 *
 *   Without env vars → dry-run mode (validates config shape, no SMTP call).
 *
 * V6 → V9 BREAKING CHANGES (what this codebase IS and IS NOT affected by)
 * ─────────────────────────────────────────────────────────────────────────
 * ✅ NOT affected  — createTransport(smtpOptions)   ← API unchanged
 * ✅ NOT affected  — transporter.sendMail(mailObj)  ← API unchanged
 * ✅ NOT affected  — transporter.verify()           ← API unchanged
 * ✅ NOT affected  — SMTP auth { user, pass }        ← same
 * ✅ NOT affected  — { host, port, secure } options ← same
 *
 * ⚠️  AFFECTED (must update nodeMailer.js root script ONLY)
 *   nodemailer.getTestMessageUrl(info)  → REMOVED in v9
 *   nodemailer.createTestAccount()      → REMOVED in v9
 *   Replace with: https://ethereal.email (manual account) or omit preview URL
 *
 * ⚠️  AFFECTED (optional but recommended for v9)
 *   The `from` field MUST match the authenticated SMTP user or be whitelisted
 *   by the provider. v9 enforces stricter envelope validation.
 *   Current services pass config.smtpMail as `from` — this is correct.
 *
 * SERVICES THAT USE NODEMAILER DIRECTLY (all use identical pattern → zero migration):
 *   Services/contacService.js     (Gmail SMTP, port 465)
 *   Services/paymentService.js    (Gmail SMTP, port 465)
 *   Services/recyclerService.js   (Gmail SMTP, port 465)
 *   Services/proposalService.js   (Gmail SMTP, port 465)
 *
 * NOTE: utils/sendMail.js and utils/auth/sendMail.js use the Brevo REST API
 *   directly (not nodemailer) — they are NOT affected by this migration.
 */

'use strict';

const nodemailer = require('nodemailer');
const { config }  = require('../config/config');

// ── Test configuration ────────────────────────────────────────────────────────

const SMTP_CONFIG = {
  host:   'smtp.gmail.com',
  port:   465,
  secure: true,
  auth: {
    user: config.smtpMail,
    pass: config.smtpMailKey,
  },
};

const TEST_MAIL = {
  from:    config.smtpMail,
  to:      config.receivermail || config.smtpMail,
  subject: '[Aynimar] Nodemailer Integration Test',
  html: `
    <h2>✅ Nodemailer Integration Test</h2>
    <p>Este correo confirma que el transporter SMTP funciona correctamente.</p>
    <p><strong>Versión nodemailer:</strong> ${require('nodemailer/package.json').version}</p>
    <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
    <hr/>
    <p style="color:#888; font-size:12px">
      Generado por test/mail-integration.js — Fase 2 auditoría de seguridad Aynimar
    </p>
  `,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.error(`  ❌ ${msg}`); process.exitCode = 1; };
const info = (msg) => console.log(`  ℹ  ${msg}`);

async function validateConfigShape(dryRun) {
  console.log('\n▶ Validating SMTP config shape...');
  const warn = (msg) => console.log(`  ⚠️  ${msg}`);
  const envCheck = dryRun ? warn : fail;

  if (!SMTP_CONFIG.host)   fail('SMTP host missing');
  else                     pass(`host = ${SMTP_CONFIG.host}`);

  if (!SMTP_CONFIG.port)   fail('SMTP port missing');
  else                     pass(`port = ${SMTP_CONFIG.port}`);

  if (!SMTP_CONFIG.secure) fail('secure flag must be true for port 465');
  else                     pass('secure = true');

  if (!SMTP_CONFIG.auth.user) envCheck('SMTP user (SMAIL) not set — required for live run');
  else                        pass(`auth.user = ${SMTP_CONFIG.auth.user}`);

  if (!SMTP_CONFIG.auth.pass) envCheck('SMTP password (GPASS) not set — required for live run');
  else                        pass('auth.pass = [SET]');

  if (!TEST_MAIL.to)   envCheck('Recipient (RMAIL) not set — required for live run');
  else                 pass(`recipient = ${TEST_MAIL.to}`);
}

async function testTransporterVerify(transporter) {
  console.log('\n▶ Verifying SMTP connection (transporter.verify())...');
  try {
    await transporter.verify();
    pass('SMTP handshake successful — credentials accepted by Gmail');
  } catch (err) {
    fail(`SMTP verify failed: ${err.message}`);
    info('Common causes: App Password not enabled, 2FA not set up, GPASS env var wrong');
    throw err;
  }
}

async function testSendMail(transporter) {
  console.log('\n▶ Sending test email (transporter.sendMail())...');
  try {
    const result = await transporter.sendMail(TEST_MAIL);
    pass(`Message sent — messageId: ${result.messageId}`);
    pass(`Accepted: ${result.accepted.join(', ')}`);

    // getTestMessageUrl was REMOVED in nodemailer v9.
    // Do NOT call it here. If you need an Ethereal preview, create a manual
    // test account at https://ethereal.email and use a dedicated transporter.
    info('NOTE: nodemailer.getTestMessageUrl() removed in v9 — not called here.');
  } catch (err) {
    fail(`sendMail failed: ${err.message}`);
    throw err;
  }
}

async function testServicePattern() {
  console.log('\n▶ Validating service call pattern (mirrors contacService / paymentService)...');

  const mockInfoMail = {
    from:    config.smtpMail || 'test@example.com',
    to:      config.receivermail || config.smtpMail || 'test@example.com',
    subject: 'Test integration pattern',
    html:    '<p>Integration test</p>',
  };

  // This is the EXACT pattern used by all 4 services — must work on v6 and v9
  const transporter = nodemailer.createTransport(SMTP_CONFIG);
  pass('nodemailer.createTransport(smtpConfig) → OK (API unchanged in v9)');

  // Validate that sendMail method exists on the transporter
  if (typeof transporter.sendMail !== 'function')
    fail('transporter.sendMail is not a function');
  else
    pass('transporter.sendMail is a function → OK');

  // Validate that verify method exists
  if (typeof transporter.verify !== 'function')
    fail('transporter.verify is not a function');
  else
    pass('transporter.verify is a function → OK');

  return { transporter, mockInfoMail };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const nmVersion = require('nodemailer/package.json').version;
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(` Nodemailer Integration Test — v${nmVersion}`);
  console.log(`══════════════════════════════════════════════════════`);

  const dryRun = !config.smtpMail || !config.smtpMailKey;

  if (dryRun) {
    info('DRY-RUN MODE: SMAIL or GPASS not set — skipping live SMTP calls');
    info('Set env vars to run with actual SMTP connection.');
  }

  await validateConfigShape(dryRun);
  const { transporter } = await testServicePattern();

  if (!dryRun) {
    await testTransporterVerify(transporter);
    await testSendMail(transporter);
  } else {
    info('Skipping SMTP verify and sendMail (dry-run mode)');
  }

  console.log('\n══════════════════════════════════════════════════════');
  if (process.exitCode === 1) {
    console.log(' ❌ Integration test FAILED — see errors above');
  } else {
    console.log(` ✅ Integration test PASSED (nodemailer v${nmVersion})`);
    if (dryRun) console.log('    Run with SMAIL + GPASS + RMAIL for full SMTP validation');
  }
  console.log('══════════════════════════════════════════════════════\n');
}

run().catch((err) => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
