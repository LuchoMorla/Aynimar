const { Worker } = require('bullmq');
const { connection } = require('../libs/cartRecoveryQueue');
const sequelize = require('../libs/sequelize');
const resend = require('../libs/resend');
const { abandonedCartEmail } = require('../templates/abandonedCartEmail');

const CART_RECOVERY_QUEUE = 'cart-recovery';

const worker = new Worker(
  CART_RECOVERY_QUEUE,
  async (job) => {
    const { orderId, guestEmail } = job.data;

    if (!guestEmail) {
      console.log(`[CartRecovery] Job ${job.id} — order ${orderId} has no email, skipping`);
      return { skipped: true, reason: 'no_email' };
    }

    const { models } = sequelize;
    const order = await models.Order.findByPk(orderId, { include: ['items'] });

    if (!order) {
      console.log(`[CartRecovery] Job ${job.id} — order ${orderId} not found, skipping`);
      return { skipped: true, reason: 'order_not_found' };
    }

    if (order.state !== 'carrito') {
      console.log(
        `[CartRecovery] Job ${job.id} — order ${orderId} already in state "${order.state}", skipping`
      );
      return { skipped: true, reason: 'already_purchased' };
    }

    if (!order.items || order.items.length === 0) {
      console.log(`[CartRecovery] Job ${job.id} — order ${orderId} has no items, skipping`);
      return { skipped: true, reason: 'empty_cart' };
    }

    const { error } = await resend.emails.send({
      from: 'Nutria de Aynimar <nutria@aynimar.com>',
      to: guestEmail,
      subject: '¿Olvidaste algo? Tu carrito te espera 🦦',
      html: abandonedCartEmail(orderId, order.items),
    });

    if (error) {
      console.error(`[CartRecovery] Resend error for order ${orderId}:`, error);
      throw new Error(`Resend: ${error.message}`);
    }

    console.log(`[CartRecovery] Recovery email sent → ${guestEmail} (order ${orderId})`);
    return { sent: true, to: guestEmail, orderId };
  },
  { connection }
);

worker.on('completed', (job, result) => {
  if (!result?.skipped) {
    console.log(`[CartRecovery] ✓ Job ${job.id} completed — email sent to ${result?.to}`);
  }
});

worker.on('failed', (job, err) => {
  console.error(`[CartRecovery] ✗ Job ${job?.id} failed:`, err.message);
});

module.exports = worker;
