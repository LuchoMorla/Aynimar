/* eslint-disable no-console */
'use strict';

const { Op } = require('sequelize');
const sequelize = require('../libs/sequelize');
const OrderService = require('../Services/orderService');

const { models } = sequelize;
const orderService = new OrderService();
const MAX_DISPATCH_ATTEMPTS = OrderService.MAX_DISPATCH_ATTEMPTS;

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS  = 15 * 1000;     // wait 15s after boot for DB to settle

// Recoge órdenes cuyo despacho no se completó:
//   - PENDING_DISPATCH        → la FASE 2 síncrona murió antes de despachar
//   - PENDING_DROPI_FULFILLMENT → un intento falló y quedan reintentos
// El guard dropiOrderId=null + el claim atómico dentro de _dispatchOrder
// evitan el doble despacho si la FASE 2 aún está corriendo.
async function retryPendingDropiOrders() {
  try {
    const pending = await models.Order.findAll({
      where: {
        fulfillmentStatus:     { [Op.in]: ['PENDING_DISPATCH', 'PENDING_DROPI_FULFILLMENT'] },
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
      const icon = r.status === 'DISPATCHED' ? '✅' : r.status === 'FAILED' ? '❌' : 'ℹ️';
      console.log(`[DropiRetry] ${icon} Orden #${row.id} → ${r.status}`);
    }
  } catch (err) {
    console.error('[DropiRetry] Worker error (non-fatal):', err.message);
  }
}

// Start worker
setTimeout(retryPendingDropiOrders, STARTUP_DELAY_MS);
const retryInterval = setInterval(retryPendingDropiOrders, RETRY_INTERVAL_MS);

// Prevent the interval from blocking graceful shutdown
if (retryInterval.unref) retryInterval.unref();

console.log(
  `[DropiRetry] Worker started — polling every ${RETRY_INTERVAL_MS / 1000}s, ` +
  `máx ${MAX_DISPATCH_ATTEMPTS} intentos por orden`
);
