/* eslint-disable no-console */
'use strict';

const { Op } = require('sequelize');
const sequelize = require('../libs/sequelize');
const OrderService = require('../Services/orderService');
const automation = require('../Services/orderAutomationService');

const { models } = sequelize;
const orderService = new OrderService();
const MAX_DISPATCH_ATTEMPTS = OrderService.MAX_DISPATCH_ATTEMPTS;

const RETRY_INTERVAL_MS  = 5 * 60 * 1000;  // 5 minutes
const STATUS_INTERVAL_MS = 30 * 60 * 1000; // sondeo de estados en Dropi
const STARTUP_DELAY_MS   = 15 * 1000;      // wait 15s after boot for DB to settle

// Recoge órdenes cuyo despacho no se completó:
//   - PENDING_DISPATCH          → la FASE 2 síncrona murió antes de despachar
//   - PENDING_DROPI_FULFILLMENT → un intento falló de forma DEFINITIVA y quedan reintentos
//   - CONFIRMED                 → confirmada en Telegram pero el envío no llegó a empezar
// Nunca recoge SENDING ni DISPATCH_UNKNOWN (podrían existir ya en Dropi).
async function retryPendingDropiOrders() {
  try {
    await sweepStuckSending();
    const pending = await models.Order.findAll({
      where: {
        fulfillmentStatus:     { [Op.in]: ['PENDING_DISPATCH', 'PENDING_DROPI_FULFILLMENT', 'CONFIRMED'] },
        dropiOrderId:          null,
        fulfillmentRetryCount: { [Op.lt]: MAX_DISPATCH_ATTEMPTS },
      },
      attributes: ['id'],
    });

    if (pending.length === 0) return;
    console.log(`[DropiRetry] ${pending.length} orden(es) pendiente(s) de despacho`);

    for (const row of pending) {
      const order = await orderService.findOne(row.id);
      if (!order) continue;
      const r = await orderService._dispatchOrder(order);
      console.log(`[DropiRetry] Orden #${row.id} → ${r.status}`);
    }
  } catch (err) {
    console.error('[DropiRetry] Worker error (non-fatal):', err.message);
  }
}

// Un SENDING más antiguo que ORDER_SENDING_TIMEOUT_MIN = el proceso murió en mitad
// del POST: no se sabe si Dropi creó la orden → DISPATCH_UNKNOWN + excepción.
async function sweepStuckSending(now = new Date()) {
  const cutoff = new Date(now.getTime() - automation.getConfig().stuckSendingMin * 60 * 1000);
  const stuck = await models.Order.findAll({
    where: { fulfillmentStatus: 'SENDING', dropiOrderId: null, dispatchStartedAt: { [Op.lt]: cutoff } },
    attributes: ['id'],
  });
  for (const { id } of stuck) {
    const [n] = await models.Order.update(
      { fulfillmentStatus: 'DISPATCH_UNKNOWN', fulfillmentError: 'Envío interrumpido (SENDING sin respuesta)' },
      { where: { id, fulfillmentStatus: 'SENDING' } }
    );
    if (n) await automation.openException(id, 'dispatch_unknown', { reason: 'SENDING colgado: el proceso murió durante el envío', shopOrderId: `AYNIMAR-${id}` });
  }
  return stuck.length;
}

// Sondeo de estados (Dropi no ofrece webhooks a terceros). Solo con la automatización activa.
async function syncDispatchedStatuses(limit = 50) {
  if (automation.getConfig().mode === 'off') return 0;
  try {
    const rows = await models.Order.findAll({
      where: {
        fulfillmentStatus: 'DISPATCHED',
        dropiOrderId: { [Op.ne]: null },
        stateOrder: { [Op.notIn]: ['entregado', 'devuelto', 'cancelado'] },
      },
      attributes: ['id'],
      order: [['id', 'ASC']],
      limit,
    });
    for (const { id } of rows) await orderService.syncDropiDeliveryStatus(id).catch((e) => console.warn(`[DropiStatus] #${id}: ${e.message}`));
    return rows.length;
  } catch (err) {
    console.error('[DropiStatus] error (non-fatal):', err.message);
    return 0;
  }
}

if (process.env.DROPI_RETRY_WORKER_AUTOSTART !== 'false') {
  setTimeout(retryPendingDropiOrders, STARTUP_DELAY_MS);
  const retryInterval = setInterval(retryPendingDropiOrders, RETRY_INTERVAL_MS);
  const statusInterval = setInterval(syncDispatchedStatuses, STATUS_INTERVAL_MS);
  // Prevent the intervals from blocking graceful shutdown
  if (retryInterval.unref) retryInterval.unref();
  if (statusInterval.unref) statusInterval.unref();

  console.log(
    `[DropiRetry] Worker started — polling every ${RETRY_INTERVAL_MS / 1000}s, ` +
    `máx ${MAX_DISPATCH_ATTEMPTS} intentos por orden`
  );
}

module.exports = { retryPendingDropiOrders, sweepStuckSending, syncDispatchedStatuses };
