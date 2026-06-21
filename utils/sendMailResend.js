'use strict';

const resend = require('../libs/resend');

// Verified Resend sender — must match the domain authenticated in Resend dashboard.
const FROM_ADDRESS = 'Aynimar <nutria@aynimar.com>';

/**
 * Drop-in replacement for nodemailer sendMail.
 * Accepts the same infoMail shape used across all Aynimar services:
 *   { from, to, subject, html }
 *
 * `from` is intentionally ignored — all outbound mail routes through the
 * verified Resend sender. The original Gmail address was only valid for
 * SMTP auth and has no meaning for Resend.
 *
 * `to` supports both plain strings and comma-separated strings:
 *   "user@example.com"
 *   "admin@aynimar.com, owner@aynimar.com"
 */
async function sendMailResend(infoMail) {
  const toAddresses = Array.isArray(infoMail.to)
    ? infoMail.to
    : infoMail.to.split(',').map((addr) => addr.trim()).filter(Boolean);

  const { data, error } = await resend.emails.send({
    from:    FROM_ADDRESS,
    to:      toAddresses,
    subject: infoMail.subject,
    html:    infoMail.html,
  });

  if (error) {
    const msg = error.message ?? JSON.stringify(error);
    console.error('[sendMailResend] Resend rejected the email:', msg);
    throw new Error(`[Resend] ${msg}`);
  }

  console.log(`[sendMailResend] Sent → ${infoMail.to} | id: ${data?.id}`);
  return { message: `mail sent to ${infoMail.to}`, resendId: data?.id };
}

module.exports = sendMailResend;
