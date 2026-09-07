'use strict';

/**
 * Payment Proof Service — Paso 11 (DeUna QR + comprobante).
 *
 * Flujo: catalog pricing → orderTotals → total final de la orden (ya fijado
 * por checkout(), sin tocar) → QR DeUna (info estática, solo lectura) →
 * comprobante (evidencia, NUNCA confirma) → revisión admin → aprobación
 * (ÚNICO punto que confirma el pago) → despacho (reutiliza
 * OrderService._finalizeAndDispatch, el mismo camino que confirmCod).
 *
 * DeUna: el "QR" es un link ESTÁTICO de cobro del comercio (no es API, no hay
 * webhook, no lleva monto/referencia embebidos — investigación ya realizada,
 * ver memoria del proyecto). No existe validación automática posible: la
 * verificación SIEMPRE es manual, vía revisión humana del comprobante.
 *
 * Este archivo NUNCA recalcula el total de la orden ni toca
 * Services/orderTotals.js — solo lee `order.total`, ya calculado.
 */

const boom = require('@hapi/boom');
const sequelize = require('../libs/sequelize');
const { models } = sequelize;
const OrderService = require('./orderService');
const { assertTrustedProofUrl, verifyProofFileExists } = require('./paymentProofImageValidation');

const orderService = new OrderService();

// Link ESTÁTICO de cobro DeUna (cuenta ****5005) — investigado y confirmado
// previamente, no inventado. Overridable por env var si el negocio rota el
// link, sin requerir redeploy de código.
const DEUNA_PAYMENT_LINK = process.env.DEUNA_PAYMENT_LINK
  || 'https://pagar.deuna.app/H92p/merchant?id=0fc6fb5506b05dda47e57dc1dd10b2176e2f34d3';

const STAFF_ROLES = ['admin', 'business_owner'];

function isStaff(userRole) {
  return STAFF_ROLES.includes(userRole);
}

async function _loadOrderForPayment(orderId) {
  const order = await models.Order.findByPk(orderId, {
    include: [{ association: 'customer' }],
  });
  if (!order) throw boom.notFound('Orden no encontrada');
  return order;
}

function _assertOwnerOrStaff(order, userId, userRole) {
  if (isStaff(userRole)) return;
  if (!order.customer || order.customer.userId !== userId) {
    throw boom.forbidden('Esta orden no te pertenece');
  }
}

/**
 * Información de pago DeUna para una orden — 100% LECTURA, nunca escribe
 * nada. El monto/referencia que se devuelven son SOLO para que el cliente los
 * use al pagar/anotar en el comprobante — el QR de DeUna en sí no los lleva
 * embebidos (es un link estático), así que la identificación real del pago
 * ocurre por revisión manual del comprobante, no por el QR.
 *
 * @param {number|string} orderId
 * @param {number} userId
 * @param {string} userRole
 */
async function getDeunaPaymentInfo(orderId, userId, userRole) {
  const order = await _loadOrderForPayment(orderId);
  _assertOwnerOrStaff(order, userId, userRole);

  return {
    paymentLink: DEUNA_PAYMENT_LINK,
    orderReference: `AYNIMAR-${order.id}`,
    // Autoridad: el total ya calculado y persistido por checkout()/orderTotals.
    // NUNCA se recalcula ni se acepta un monto del cliente aquí.
    amountToPay: order.total,
    currency: 'USD',
    instructions:
      'Escanea el código QR o abre el link de DeUna, o transfiere/deposita directamente a ' +
      'esa misma cuenta. Paga el monto indicado y sube el comprobante de pago en Aynimar. ' +
      'La verificación del pago es manual — tu pedido quedará "pago pendiente de ' +
      'verificación" hasta que un administrador lo revise.',
  };
}

/**
 * Sube un comprobante de pago DeUna. NUNCA confirma el pago por sí sola —
 * solo registra evidencia y mueve la orden a 'pending_verification'.
 *
 * @param {number|string} orderId
 * @param {{fileUrl:string}} data
 * @param {number} userId       Quien sube (cliente dueño, o staff en su nombre).
 * @param {string} userRole
 */
async function uploadProof(orderId, { fileUrl }, userId, userRole) {
  const order = await _loadOrderForPayment(orderId);
  // Autorización PRIMERO — antes de validar cualquier detalle de la URL, para
  // no darle a un no-autorizado ninguna pista sobre qué se espera.
  _assertOwnerOrStaff(order, userId, userRole);

  // 1. Estructural, sin red: dominio confiable (Firebase Storage propio),
  //    carpeta esperada, carpeta de ESTA orden (order.id, no un orderId sin
  //    validar), extensión de imagen permitida. Falla rápido antes de hacer
  //    cualquier llamada de red. Usar order.id (ya cargado y numérico) en
  //    vez del orderId crudo del request evita cualquier ambigüedad de tipo.
  assertTrustedProofUrl(fileUrl, order.id);

  // Solo tiene sentido subir un comprobante DESPUÉS de checkout() (que ya
  // calculó el total autoritativo) y ANTES de que el pago esté resuelto.
  if (order.state !== 'comprada') {
    throw boom.conflict(
      `Esta orden no tiene un pago pendiente por confirmar (estado: ${order.state}).`
    );
  }
  if (order.paymentStatus === 'paid') {
    throw boom.conflict('Esta orden ya está pagada.');
  }
  if (order.fulfillmentStatus === 'DISPATCHED') {
    throw boom.conflict('Esta orden ya fue despachada.');
  }

  // Comprobante duplicado: mismo archivo ya subido para esta misma orden.
  const duplicate = await models.PaymentProof.findOne({
    where: { orderId: order.id, fileUrl },
  });
  if (duplicate) {
    throw boom.conflict('Este comprobante ya fue subido para esta orden.');
  }

  // 2. Real, con red: el archivo EXISTE de verdad en el storage, con
  //    Content-Type/tamaño de imagen válidos — recién ahora, justo antes de
  //    persistir (evita gastar la llamada de red en una orden que de todas
  //    formas iba a ser rechazada por los guards anteriores).
  await verifyProofFileExists(fileUrl);

  return sequelize.transaction(async (t) => {
    const proof = await models.PaymentProof.create(
      { orderId: order.id, fileUrl, uploadedByUserId: userId, status: 'pending' },
      { transaction: t }
    );
    // Subir NO confirma el pago — solo dispara la revisión manual.
    await order.update(
      { paymentMethod: 'deuna', paymentStatus: 'pending_verification' },
      { transaction: t }
    );
    return proof;
  });
}

/**
 * Lista los comprobantes de una orden (dueño o staff).
 */
async function listProofs(orderId, userId, userRole) {
  const order = await _loadOrderForPayment(orderId);
  _assertOwnerOrStaff(order, userId, userRole);
  return models.PaymentProof.findAll({
    where: { orderId: order.id },
    order: [['id', 'DESC']],
  });
}

/**
 * Reclama atómicamente un comprobante 'pending' → nextStatus. UPDATE
 * condicionado (WHERE status='pending', mismo patrón de claim optimista ya
 * usado en OrderService._dispatchOrder con fulfillmentRetryCount) — si dos
 * revisiones llegan a la vez, solo una consigue affectedRows=1; la otra
 * recibe 409 sin tocar nada más.
 */
async function _claimProof(orderId, proofId, adminUserId, nextStatus, extra = {}) {
  const proof = await models.PaymentProof.findOne({ where: { id: proofId, orderId } });
  if (!proof) throw boom.notFound('Comprobante no encontrado para esta orden.');

  const [claimed] = await models.PaymentProof.update(
    { status: nextStatus, reviewedByUserId: adminUserId, reviewedAt: new Date(), ...extra },
    { where: { id: proofId, orderId, status: 'pending' } }
  );
  if (claimed === 0) {
    throw boom.conflict('Este comprobante ya fue revisado.');
  }
  return models.PaymentProof.findByPk(proofId);
}

/**
 * Aprueba un comprobante — el ÚNICO camino que confirma un pago DeUna.
 * Solo staff (admin/business_owner) llega aquí — nunca el cliente (guard de
 * rol en la ruta; esta función ni siquiera acepta un "modo cliente").
 *
 * 1. Re-verifica que el archivo SIGA existiendo con Content-Type/tamaño
 *    válidos — Firebase Storage no garantiza que un objeto sea inmutable
 *    entre la subida y esta revisión (ver auditoría de Storage Rules), así
 *    que nunca se confía en la verificación hecha al momento de subir.
 * 2. Reclama el comprobante de forma atómica (protege doble aprobación).
 * 3. Solo si se reclamó, confirma la orden vía OrderService (mismo camino
 *    que confirmCod → stock + transición + despacho idempotente).
 */
async function approveProof(orderId, proofId, adminUserId) {
  const existingProof = await models.PaymentProof.findOne({ where: { id: proofId, orderId } });
  if (!existingProof) throw boom.notFound('Comprobante no encontrado para esta orden.');
  if (existingProof.status !== 'pending') {
    throw boom.conflict('Este comprobante ya fue revisado.');
  }
  await verifyProofFileExists(existingProof.fileUrl);

  const updatedProof = await _claimProof(orderId, proofId, adminUserId, 'approved');

  try {
    const orderResult = await orderService.confirmPaymentProof(orderId, {
      paymentMethod: 'deuna',
      paymentStatus: 'paid',
    });
    return { proof: updatedProof, order: orderResult };
  } catch (err) {
    // El comprobante queda 'approved' — es un registro histórico e
    // inmutable de la revisión, no se revierte. La orden normalmente no
    // pudo confirmarse porque ya fue procesada por otro camino (COD, u otro
    // comprobante) en el intervalo — nunca produce un segundo despacho.
    console.error(
      `[PaymentProof] Comprobante ${proofId} aprobado pero la orden ${orderId} no pudo confirmarse: ${err.message}`
    );
    throw err;
  }
}

/**
 * Rechaza un comprobante. Si la orden seguía 'pending_verification' por este
 * comprobante, vuelve a 'failed' (permite que el cliente suba uno corregido).
 * Si la orden ya fue resuelta por otro camino, no se toca (evita corromper
 * un pago ya confirmado por un comprobante distinto).
 */
async function rejectProof(orderId, proofId, adminUserId, reason) {
  const order = await _loadOrderForPayment(orderId);
  const updatedProof = await _claimProof(orderId, proofId, adminUserId, 'rejected', {
    reviewNote: reason ?? null,
  });

  if (order.paymentStatus === 'pending_verification') {
    await order.update({ paymentStatus: 'failed' });
  }
  return updatedProof;
}

module.exports = {
  DEUNA_PAYMENT_LINK,
  getDeunaPaymentInfo,
  uploadProof,
  listProofs,
  approveProof,
  rejectProof,
};
