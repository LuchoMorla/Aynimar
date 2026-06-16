'use strict';

const express = require('express');
const resend  = require('../libs/resend');

const router = express.Router();

const adminSecret = process.env.ADMIN_TEST_SECRET;

function requireAdminSecret(req, res, next) {
  if (!adminSecret) {
    return res.status(503).json({ error: 'ADMIN_TEST_SECRET not configured in Railway.' });
  }
  if (req.headers['x-admin-secret'] !== adminSecret) {
    return res.status(401).json({ error: 'Invalid x-admin-secret header.' });
  }
  next();
}

// POST /api/v1/test/email
// Body: { email: "someone@example.com" }
// Headers: x-admin-secret: <ADMIN_TEST_SECRET>
router.post('/email', requireAdminSecret, async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Provide a valid "email" in the request body.' });
  }

  console.log(`[EmailService] Intentando enviar correo a: ${email}`);

  const payload = {
    from: 'Nutria de Aynimar <nutria@aynimar.com>',
    to:   email,
    subject: '[Test] Verificación del motor de correos Resend — Aynimar',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
        <img src="https://www.aynimar.com/_next/static/media/logo-Aynimar.c247031e.svg"
             alt="Aynimar" style="height:40px;margin-bottom:16px" />
        <h2 style="color:#059669">Motor de correos funcionando</h2>
        <p>Este es un correo de prueba generado desde el endpoint
           <code>/api/v1/test/email</code> para validar que <strong>Resend</strong>
           está correctamente configurado.</p>
        <p>Si recibes este mensaje, el API key y el dominio están verificados.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
        <p style="color:#6b7280;font-size:12px">Aynimar — Ecuador</p>
      </div>
    `,
  };

  const { data, error } = await resend.emails.send(payload);

  console.log(`[EmailService] Respuesta de Resend:`, JSON.stringify(error ?? data));

  if (error) {
    return res.status(502).json({
      status:  'error',
      message: 'Resend rechazó el envío.',
      resend_error: error,
    });
  }

  return res.json({
    status:  'success',
    message: `Correo enviado a ${email}`,
    resend_id: data?.id ?? null,
  });
});

module.exports = router;
