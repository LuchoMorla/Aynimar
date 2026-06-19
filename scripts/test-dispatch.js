/* eslint-disable no-console */
/**
 * Fire test for Dropi order dispatch.
 *
 * Usage:
 *   node scripts/test-dispatch.js <orderId>
 *
 * What it does:
 *   1. Loads the order from DB (with customer + items)
 *   2. Calls dispatchToProviders() — the same path used on checkout
 *   3. Prints the Dropi response or the error in detail
 *   4. Does NOT update the DB — read-only diagnostic
 *
 * Example:
 *   node scripts/test-dispatch.js 42
 */
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const orderId = parseInt(process.argv[2], 10);
if (!orderId || isNaN(orderId)) {
  console.error('Usage: node scripts/test-dispatch.js <orderId>');
  process.exit(1);
}

// Bootstrap Sequelize (same as production)
const sequelize = require('../libs/sequelize');
const OrderService = require('../Services/orderService');

const orderService = new OrderService();

async function main() {
  try {
    await sequelize.authenticate();
    console.log(`[TestDispatch] DB connected — testing dispatch for order #${orderId}\n`);

    const order = await orderService.findOne(orderId);
    if (!order) {
      console.error(`[TestDispatch] Order #${orderId} not found`);
      process.exit(1);
    }

    console.log('[TestDispatch] Order state:       ', order.state);
    console.log('[TestDispatch] Fulfillment status:', order.fulfillmentStatus ?? '(none)');
    console.log('[TestDispatch] Dropi order ID:    ', order.dropiOrderId ?? '(none)');
    console.log('[TestDispatch] Items count:       ', order.items?.length ?? 0);

    if (!order.customer) {
      console.error('[TestDispatch] Order has no customer — cannot build shipping address');
      process.exit(1);
    }

    console.log('\n[TestDispatch] Customer:', order.customer.name, order.customer.lastName);
    console.log('[TestDispatch] Address: ', order.customer.streetAddress, '|', order.customer.city, '|', order.customer.province);

    console.log('\n[TestDispatch] Items:');
    for (const item of (order.items ?? [])) {
      console.log(`  - ${item.name} (id=${item.id}) qty=${item.OrderProduct?.amount} sourceProvider=${item.sourceProvider ?? 'own'} dropiProductId=${item.dropiProductId ?? '-'} dropiItems=${JSON.stringify(item.dropiItems ?? [])}`);
    }

    console.log('\n[TestDispatch] Calling dispatchToProviders()...\n');
    const result = await orderService.dispatchToProviders(order);

    if (!result) {
      console.log('[TestDispatch] Result: No Dropi items found — order would be marked MANUAL_LOGISTICS');
    } else {
      console.log('[TestDispatch] ✅ SUCCESS');
      console.log('[TestDispatch] Dropi Order ID:', result.dropiOrderId ?? '(no ID returned)');
    }
  } catch (err) {
    console.error('\n[TestDispatch] ❌ DISPATCH FAILED');
    console.error('Error:', err.message);
    if (err.response?.data) {
      console.error('Dropi response body:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

main();
