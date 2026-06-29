'use strict';

/**
 * merchantSyncService — Agente de Sincronización con Google Merchant Center
 *
 * validateProductSync(productId):
 *   1. Extrae el producto de la BD
 *   2. Ejecuta validaciones contra las reglas de Google
 *   3. Envía reporte proactivo por Telegram
 *   4. Si válido → devuelve { ready: true, confirmUrl } y espera confirmación
 *   5. Si inválido → devuelve issues con fix sugerido por campo
 *
 * El envío real a Google requiere llamar syncProductToMerchant() por separado
 * (POST /api/v1/products/:id/sync-merchant) — nunca auto-ejecutado.
 */

const ProductsService = require('./productServices');
const { validateProductForMerchant } = require('../libs/google-merchant');
const { sendTelegramNotification }    = require('../utils/telegramNotify');

const productSvc = new ProductsService();

function buildTelegramReport(productId, product, report) {
  const name = product?.name || `Producto #${productId}`;

  if (report.valid) {
    const warnLines = report.warnings.length > 0
      ? '\n\n⚠️ <b>Advertencias (no bloquean el envío):</b>\n' +
        report.warnings.map(w => `  • <b>${w.field}</b>: ${w.reason}\n    💡 ${w.fix}`).join('\n')
      : '';

    return (
      `🟢 <b>Agente Merchant — LISTO PARA ENVIAR</b>\n\n` +
      `📦 <b>${name}</b> (ID: ${productId})\n` +
      `✅ Todas las validaciones pasaron.\n` +
      `${warnLines}\n\n` +
      `<b>Payload preparado:</b>\n` +
      `  • Título: ${report.payload.title}\n` +
      `  • Precio: ${report.payload.price.currency} ${report.payload.price.value}\n` +
      `  • Disponibilidad: ${report.payload.availability}\n` +
      `  • Imagen: ${report.payload.imageLink ? '✅' : '❌ falta'}\n\n` +
      `⏸ <b>Detenido — esperando tu confirmación.</b>\n` +
      `Para enviar a Google Merchant ejecuta:\n` +
      `<code>POST /api/v1/products/${productId}/sync-merchant</code>`
    );
  }

  const issueLines = report.issues
    .map((i, idx) => `${idx + 1}. <b>${i.field}</b>\n   ❌ ${i.reason}\n   🔧 ${i.fix}`)
    .join('\n\n');

  const warnLines = report.warnings.length > 0
    ? '\n\n⚠️ <b>Advertencias adicionales:</b>\n' +
      report.warnings.map(w => `  • ${w.field}: ${w.reason}`).join('\n')
    : '';

  return (
    `🔴 <b>Agente Merchant — BLOQUEADO</b>\n\n` +
    `📦 <b>${name}</b> (ID: ${productId})\n` +
    `❌ ${report.issues.length} problema${report.issues.length > 1 ? 's' : ''} encontrado${report.issues.length > 1 ? 's' : ''}.\n\n` +
    `<b>Issues a corregir:</b>\n\n${issueLines}` +
    `${warnLines}\n\n` +
    `Corrige los campos indicados y vuelve a ejecutar la validación.`
  );
}

async function validateProductSync(productId) {
  const product = await productSvc.findOne(productId);
  const report  = validateProductForMerchant(product);

  // Telegram notification — fire-and-forget, never blocks the response
  sendTelegramNotification(buildTelegramReport(productId, product, report)).catch(() => {});

  if (report.valid) {
    return {
      status:     'ready',
      summary:    report.summary,
      warnings:   report.warnings,
      payload:    report.payload,
      confirmUrl: `POST /api/v1/products/${productId}/sync-merchant`,
      message:    'Producto válido. Llama a confirmUrl para enviarlo a Google Merchant Center.',
    };
  }

  return {
    status:  'blocked',
    summary: report.summary,
    issues:  report.issues,   // cada issue tiene .field, .reason, .fix
    warnings: report.warnings,
    message: `Corrige los ${report.issues.length} issue(s) en la BD y vuelve a validar.`,
  };
}

module.exports = { validateProductSync };
