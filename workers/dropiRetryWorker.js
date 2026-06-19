/* eslint-disable no-console */
'use strict';

const { Op } = require('sequelize');
const sequelize = require('../libs/sequelize');
const OrderService = require('../Services/orderService');
const { sendTelegramNotification } = require('../utils/telegramNotify');

const { models } = sequelize;
const orderService = new OrderService();

const MAX_RETRIES       = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS  = 15 * 1000;     // wait 15s after boot for DB to settle

async function retryPendingDropiOrders() {
  try {
    const pending = await models.Order.findAll({
      where: {
        fulfillmentStatus:    'PENDING_DROPI_FULFILLMENT',
        fulfillmentRetryCount: { [Op.lt]: MAX_RETRIES },
      },
      attributes: ['id', 'fulfillmentRetryCount', 'fulfillmentError', 'fulfillmentStatus'],
    });

    if (pending.length === 0) return;

    console.log(`[DropiRetry] ${pending.length} orden(es) pendiente(s) de despacho — iniciando reintentos`);

    for (const order of pending) {
      const attempt = (order.fulfillmentRetryCount ?? 0) + 1;
      console.log(`[DropiRetry] Orden #${order.id} — intento ${attempt}/${MAX_RETRIES}`);

      try {
        await orderService.retryFulfillment(order.id);
        // retryFulfillment() updates fulfillmentStatus to DISPATCHED on success — no extra update needed
        console.log(`[DropiRetry] ✅ Orden #${order.id} despachada a Dropi en intento ${attempt}`);
      } catch (err) {
        // retryFulfillment() already wrote fulfillmentError — we only update the retry counter here
        const updates = { fulfillmentRetryCount: attempt };

        if (attempt >= MAX_RETRIES) {
          updates.fulfillmentStatus = 'FAILED_DROPI_FULFILLMENT';
          const alert =
            `🚨 <b>FALLO DROPI — Orden #${order.id}</b>\n` +
            `Agotados ${MAX_RETRIES} reintentos automáticos.\n` +
            `Error: ${err.message.slice(0, 300)}\n` +
            `⚠️ Intervención manual requerida desde el dashboard → Órdenes → Reintentar despacho.`;
          console.error(`[DropiRetry] ❌ Orden #${order.id} FAILED after ${MAX_RETRIES} attempts: ${err.message}`);
          sendTelegramNotification(alert).catch((tErr) =>
            console.error('[DropiRetry] Telegram alert failed:', tErr.message)
          );
        } else {
          console.warn(`[DropiRetry] Intento ${attempt} fallido para orden #${order.id}: ${err.message}`);
        }

        await order.update(updates).catch((dbErr) =>
          console.error(`[DropiRetry] Could not update retry count for order #${order.id}:`, dbErr.message)
        );
      }
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

console.log(`[DropiRetry] Worker started — polling every ${RETRY_INTERVAL_MS / 1000}s, max ${MAX_RETRIES} retries per order`);
