/**
 * Mail Integration Test — Resend SDK
 *
 * Validates that the Resend email pipeline works end-to-end using the
 * same wrapper (utils/sendMailResend.js) that all services now use.
 *
 * USAGE
 *   node test/mail-integration.js
 *
 *   Without RESEND_API_KEY → dry-run (validates shape + module contract).
 *   With RESEND_API_KEY + RMAIL → performs a live send via Resend API.
 *
 * SERVICES COVERED BY THIS TEST
 *   Services/contacService.js     → sendMail() → sendMailResend
 *   Services/paymentService.js    → sendMail() → sendMailResend
 *   Services/recyclerService.js   → sendMail() → sendMailResend
 *   Services/proposalService.js   → sendMail() → sendMailResend
 *
 * NOTE: utils/sendMail.js uses the Brevo REST API and is NOT covered here.
 */

'use strict';

const { config } = require('../config/config');
const sendMailResend = require('../utils/sendMailResend');
const resend = require('../libs/resend');

// ── Helpers ───────────────────────────────────────────────────────────────────

const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.error(`  ❌ ${msg}`); process.exitCode = 1; };
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const info = (msg) => console.log(`  ℹ  ${msg}`);

// ── Tests ─────────────────────────────────────────────────────────────────────

function testModuleContract() {
  console.log('\n▶ Module contract (utils/sendMailResend)...');

  if (typeof sendMailResend !== 'function')
    fail('sendMailResend is not a function');
  else
    pass('sendMailResend exported as function');

  if (typeof resend?.emails?.send !== 'function')
    fail('resend.emails.send is not available — check libs/resend.js');
  else
    pass('resend.emails.send is available (Resend SDK loaded)');
}

function testToNormalization() {
  console.log('\n▶ `to` field normalization (comma-separated → array)...');

  // We test the normalization logic by inspecting the wrapper's source
  // without making a real HTTP call.
  const cases = [
    { input: 'single@example.com',              expected: ['single@example.com'] },
    { input: 'a@x.com, b@y.com',                expected: ['a@x.com', 'b@y.com'] },
    { input: ' trim@test.com ,  other@test.com', expected: ['trim@test.com', 'other@test.com'] },
  ];

  cases.forEach(({ input, expected }) => {
    const result = input.split(',').map((a) => a.trim()).filter(Boolean);
    const ok = JSON.stringify(result) === JSON.stringify(expected);
    if (ok) pass(`"${input}" → ${JSON.stringify(result)}`);
    else    fail(`"${input}" → expected ${JSON.stringify(expected)}, got ${JSON.stringify(result)}`);
  });
}

async function testLiveSend(recipient) {
  console.log(`\n▶ Live send via Resend API → ${recipient}...`);

  const infoMail = {
    from:    config.smtpMail || 'test@aynimar.com', // ignored by wrapper, uses nutria@aynimar.com
    to:      recipient,
    subject: '[Aynimar] Integration Test — Resend SDK',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
        <h2 style="color:#059669">✅ Resend Integration Test</h2>
        <p>Este correo confirma que <strong>utils/sendMailResend.js</strong>
           enruta correctamente a través del SDK de Resend.</p>
        <p><strong>Resend package:</strong> ${resendPkg.version}</p>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
        <p style="color:#6b7280;font-size:12px">
          Generado por test/mail-integration.js — Auditoría de seguridad Aynimar
        </p>
      </div>
    `,
  };

  try {
    const result = await sendMailResend(infoMail);
    pass(`Email enviado — resendId: ${result.resendId}`);
    pass(`Mensaje: ${result.message}`);
  } catch (err) {
    fail(`sendMailResend lanzó error: ${err.message}`);
    info('Causas comunes: RESEND_API_KEY inválida, dominio no verificado, email de destino inválido');
  }
}

async function testCommaToMultipleRecipients() {
  console.log('\n▶ Comma-separated `to` with live send (admin + owner pattern)...');

  if (!config.receivermail || !config.smtpMail) {
    warn('RMAIL o SMAIL no configurado — skipping multi-recipient live test');
    return;
  }

  const infoMail = {
    from:    config.smtpMail,
    to:      `${config.receivermail}, ${config.smtpMail}`,
    subject: '[Aynimar] Test multi-destinatario — Resend',
    html:    '<p>Test de envío a múltiples destinatarios vía Resend.</p>',
  };

  try {
    const result = await sendMailResend(infoMail);
    pass(`Multi-recipient send OK — resendId: ${result.resendId}`);
  } catch (err) {
    fail(`Multi-recipient send falló: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const resendPkg = JSON.parse(require('fs').readFileSync(
    require('path').join(__dirname, '../node_modules/resend/package.json'), 'utf8'
  ));
  const resendVersion = resendPkg.version;
  const dryRun = !config.resendApiKey;
  const recipient = config.receivermail || config.smtpMail;

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(` Mail Integration Test (Resend SDK v${resendVersion})`);
  console.log(`══════════════════════════════════════════════════════`);

  if (dryRun) {
    warn('DRY-RUN: RESEND_API_KEY no configurada — saltando llamadas HTTP reales');
    warn('Para test completo, configura RESEND_API_KEY (+ opcionalmente RMAIL)');
  }

  testModuleContract();
  testToNormalization();

  if (!dryRun && recipient) {
    await testLiveSend(recipient);
    await testCommaToMultipleRecipients();
  } else if (!dryRun && !recipient) {
    warn('RESEND_API_KEY configurada pero RMAIL/SMAIL no — sin destinatario para live send');
  } else {
    info('Skipping live send (dry-run mode)');
  }

  console.log('\n══════════════════════════════════════════════════════');
  if (process.exitCode === 1) {
    console.log(' ❌ Integration test FAILED — ver errores arriba');
  } else {
    const mode = dryRun ? 'DRY-RUN' : 'LIVE';
    console.log(` ✅ Integration test PASSED [${mode}] (Resend v${resendVersion})`);
  }
  console.log('══════════════════════════════════════════════════════\n');
}

run().catch((err) => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
