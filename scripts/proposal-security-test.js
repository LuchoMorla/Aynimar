'use strict';
/* eslint-disable no-console */
/**
 * POST /proposals (público) — auditoría ayni-play/03.
 * Sin red ni BD: sendMailResend se sustituye por un espía.
 * Falla si vuelve: correo a la dirección del cliente, HTML sin escapar,
 * entrada sin límite o el endpoint sin rate-limit.
 *
 * Usage: node scripts/proposal-security-test.js
 */
Object.assign(process.env, { RMAIL: 'buzon-interno@example.com', SMAIL: 'remitente@example.com' });

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

async function main() {
  const sent = [];
  const mailPath = require.resolve('../utils/sendMailResend');
  require.cache[mailPath] = { id: mailPath, filename: mailPath, loaded: true, exports: async (m) => { sent.push(m); return { message: 'ok' }; } };

  const express = require('express');
  const { logErrors, boomErrorHandler, errorHandler } = require('../middlewares/errorsHandler');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/proposals', require('../routes/proposalRouter'));
  app.use(logErrors); app.use(boomErrorHandler); app.use(errorHandler);
  const origError = console.error;
  console.error = (...a) => { if (String(a[0]).includes('FAIL')) origError(...a); }; // silencia logErrors
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/proposals`;
  const post = async (body) => {
    const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };

  console.log('\n▶ POST /proposals');
  let r = await post({ email: 'victima@example.com', name: '<b>Ana</b>\r\nBcc: x', proposal: '<script>alert(1)</script><a href="http://phish">x</a>' });
  assert('válida → 200', r.status === 200, r.text);
  assert('se envía un solo correo', sent.length === 1, JSON.stringify(sent.map((m) => m.to)));
  assert('destinatario = buzón del servidor, nunca el del cliente', sent.length > 0 && sent.every((m) => m.to === 'buzon-interno@example.com'), JSON.stringify(sent.map((m) => m.to)));
  const html = sent[0]?.html ?? '';
  assert('HTML escapado (sin <script>, <a>, <b>)', !/<script|<a |<b>/i.test(html) && html.includes('&lt;script&gt;'), html);
  assert('asunto sin saltos de línea', sent.length > 0 && !/[\r\n]/.test(sent[0]?.subject ?? ''), sent[0]?.subject);

  sent.length = 0;
  r = await post({ email: 'a@example.com', name: 'Ana', proposal: 'x'.repeat(5001) });
  assert('propuesta > 5000 → 400 sin correo', r.status === 400 && sent.length === 0, r.text);
  r = await post({ email: 'a@example.com', name: 'Ana', proposal: '   ' });
  assert('propuesta vacía → 400', r.status === 400 && sent.length === 0, r.text);
  r = await post({ email: 'no-es-correo', name: 'Ana', proposal: 'hola' });
  assert('correo inválido → 400', r.status === 400 && sent.length === 0, r.text);

  // authLimiter: 10 / 15 min por IP (ya van 4 peticiones).
  let last;
  for (let i = 0; i < 7; i++) last = await post({ email: 'a@example.com', name: 'Ana', proposal: 'hola' });
  assert('la 11.ª petición → 429', last.status === 429, `${last.status} ${last.text}`);

  server.close();
  console.log(`\n${'─'.repeat(50)}\nProposal security tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.log('Error inesperado en la suite:', err); process.exit(1); });
