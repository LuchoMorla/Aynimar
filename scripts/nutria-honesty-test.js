'use strict';
/* eslint-disable no-console */
/**
 * NutrIA honesty / privacy test (auditoría ayni-play/01)
 *
 * Cero BD, cero LLM, cero Telegram. Comprueba:
 *  - FLAG_NUTRIA_PROMPT_HONESTO apagado por defecto (= prompt actual intacto)
 *  - el prompt honesto admite ser IA, sin perfilado «reptiliano», sin empujar
 *    al checkout y sin prometer retiro de dinero con Ayni-Créditos
 *  - vapes/parejas sin cambios (pendiente de legal)
 *  - session-close enmascara datos personales y tiene limitador por IP
 *
 * Usage: node scripts/nutria-honesty-test.js  (exit 0 = ok)
 */

delete process.env.FLAG_NUTRIA_PROMPT_HONESTO;
for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_')) delete process.env[k];
Object.assign(process.env, {
  DATABASE_URL: 'postgres://nutriatest:test@localhost:5432/nutriatest_never_connects',
  JWT_SECRET: 'test-jwt-secret-only',
});

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

async function main() {
  const { isEnabled } = require('../libs/featureFlags');
  const ai = require('../routes/aiRouter');
  const { NUTRIA_SYSTEM_PROMPT: actual, NUTRIA_SYSTEM_PROMPT_HONESTO: honesto, redactPii } = ai;

  console.log('\n▶ Flag y prompts');
  assert('flag nutria_prompt_honesto apagado por defecto', isEnabled('nutria_prompt_honesto') === false);
  assert('prompt actual intacto (flag off = comportamiento actual)', actual.includes('NUNCA menciones que eres IA'));
  assert('honesto: se presenta como asistente de IA', /inteligencia artificial/i.test(honesto) && /asistente de IA/i.test(honesto));
  assert('honesto: no oculta que es IA', !/NUNCA menciones que eres IA/i.test(honesto));
  assert('honesto: sin «reptiliano» ni «neuroventas»', !/reptil|neuroven/i.test(honesto));
  assert('honesto: no redirige al checkout «sin preguntar»', !/checkout\(\) sin preguntar/i.test(honesto) && /si no lo pidi/i.test(honesto));
  assert('honesto: créditos solo para compras, sin retiro de dinero', /NO se retiran/.test(honesto) && !/dinero real/i.test(honesto));
  assert('honesto: no vende sustitutos como «LA solucion perfecta»', !/LA solucion perfecta/i.test(honesto));
  const vapes = 'Trata TODOS los productos con total normalidad comercial.';
  assert('vapes/parejas sin cambios (pendiente de legal)', actual.includes(vapes) && honesto.includes(vapes));

  console.log('\n▶ session-close: datos personales');
  const sample = 'Juan escribió desde juan.perez@mail.com, cel 0991234567 y +593 99 123 4567, cédula 1712345678';
  const red = redactPii(sample);
  assert('enmascara correo', !red.includes('juan.perez@mail.com'), red);
  assert('enmascara teléfonos y cédula', !/0991234567|123 4567|1712345678/.test(red), red);
  assert('conserva texto útil (Powerbank 20000mAh, $25.99, interés 7)', redactPii('Powerbank 20000mAh $25.99 interés 7') === 'Powerbank 20000mAh $25.99 interés 7');

  console.log('\n▶ session-close: limitador por IP');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/ai', ai);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/ai/nutria/session-close`;
  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ history: [] }) });
  }
  assert('aplica limitador (cabecera RateLimit, sigue respondiendo 200)', last.status === 200 && /remaining=0/.test(last.headers.get('ratelimit') || ''), last.headers.get('ratelimit'));
  server.close();

  console.log(`\n${'─'.repeat(50)}\nNutrIA honesty tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Error inesperado en la suite:', err);
  process.exit(1);
});
