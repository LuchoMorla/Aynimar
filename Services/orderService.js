const boom = require('@hapi/boom');
const sequelize = require('../libs/sequelize');
const { models } = sequelize;
const { Op } = require('sequelize');
const WalletService = require('./walletService');
const { createOrderInDropi, fetchDropiOrderStatus } = require('../integrations/dropi/dropiAdapter');
const { createOrderInEffi }  = require('../integrations/effi/effiAdapter');

const { config } = require('./../config/config');
// const nodemailer = require('nodemailer');
const sendMail = require('../utils/sendMail')


class OrderService {
  constructor() {}
  async create(data) {
    const customer = await models.Customer.findOne({
      where: {
        '$user.id$': data.userId,
      },
      include: ['user'],
    });
    if (!customer) {
      throw boom.badRequest('Customer not found os');
    }
    const newOrder = await models.Order.create({ customerId: customer.id });
    return newOrder;
  }

   // 1. MÉTODO PARA CREAR ORDEN DE INVITADO (nuevo)
  async createGuestOrder() {
    const newGuestOrder = await models.Order.create({});
    return newGuestOrder;
  }

  // 2. MÉTODO PARA AÑADIR ITEM A ORDEN DE INVITADO (nuevo y muy importante)
  async addItemToGuestOrder(data) {
    const order = await models.Order.findByPk(data.orderId);
    if (!order) {
      throw boom.notFound('Order not found');
    }
    // ¡Medida de seguridad! Solo se pueden agregar items a órdenes que NO tienen cliente.
    if (order.customerId) {
      throw boom.forbidden('This order is already associated with a customer. Use the standard endpoint.');
    }
    const newItem = await models.OrderProduct.create(data);
    return newItem;
  }
  
  // 3. MÉTODO PARA ASOCIAR ORDEN A CLIENTE (nuevo)
  async associateOrderToCustomer(guestOrderId, userId) {
    const customer = await models.Customer.findOne({ where: { userId } });
    if (!customer) throw boom.notFound('Customer for this user not found');

    const order = await this.findOne(guestOrderId);
    if (!order) throw boom.notFound('Guest order not found');

    if (order.customerId) {
      // Opcional: Podrías fusionar carritos aquí en el futuro.
      console.log(`Order ${guestOrderId} already belongs to customer ${order.customerId}. No action taken.`);
      return order;
    }

    return order.update({ customerId: customer.id });
  }

   // --- 4.- ESTE NUEVO MÉTODO PARA CARRITO ---
  async findGuestOrderById(orderId) {
    const order = await models.Order.findByPk(orderId, {
      include: ['items'], // Solo necesitamos los items
    });

    if (!order) {
      throw boom.notFound('Order not found');
    }

    // Medida de seguridad: Si la orden ya tiene un cliente, no la devolvemos por esta vía.
    if (order.customerId) {
      throw boom.forbidden('This is not a guest order.');
    }

    return order;
  }

  async findByUser(userId) {
    const orders = await models.Order.findAll({
      where: {
        '$customer.user.id$': userId,
      },
      include: [
        {
          association: 'customer',
          include: ['user'],
        },
        'items',
      ],
    });

    for (var i = 0; i < orders.length; i++) {
      delete orders[i].dataValues.customer.dataValues.user.dataValues.password;
    }

    return orders;
  }

  async find() {
    const orders = await models.Order.findAll({
      include: [
        {
          association: 'customer',
          include: ['user'],
        },
        'items',
      ],
    });

    for (var i = 0; i < orders.length; i++) {
      delete orders[i].dataValues.customer.dataValues.user.dataValues.password;
    }

    return orders;
  }

  async verifyProductIsInOrderActive(productId, businnesId) {
    const orders = await this.findOrdersByBusinessId(businnesId);
    const activeOrders = orders.filter(
      (order) => !['entregado', 'cancelado'].includes(order.stateOrder)
    );
    return activeOrders.some((order) =>
      order.items.some((item) => item.id === +productId)
    );
  }

  async findOne(id) {
    const order = await models.Order.findByPk(id, {
      include: [
        {
          association: 'customer',
          include: ['user'],
        },
        'items',
      ],
    });
    // --- ¡AÑADIR ESTA VALIDACIÓN! ---
    // Si la orden existe y tiene un cliente asociado (y ese cliente tiene un usuario)
    if (order && order.customer && order.customer.user) {
      delete order.customer.user.dataValues.password;
    }
    // La función ahora devuelve la orden sin fallar, incluso si es de un invitado.
    return order;
  }

  //super llamado por user id filtrando estado de orden
  async findOrderByUserIdAndState(userId, state) {
    const orders = await this.findByUser(userId);
    const ordersByState = orders.filter((order) => order.state == state);
    /*     const nueva = ordersByState.forEach((item) => {
          item.dataValues.items.forEach((itemsitos) => itemsitos.price / 100);
        });
        console.log(nueva);
        console.log(nueva.dataValues.items.dataValues.price); */
    if (ordersByState.length == 0) {
      throw boom.badRequest(`Order in state ${state} not found`);
    }
    return ordersByState[0];
  }
  //llamado de orden por id validando que coincida con su sub
  async findByOrderIdValidatedWidthUserId(userId, orderId) {
    const order = await this.findOne(orderId);
    if (!order) {
      throw boom.badRequest('order not found');
    }
    const userToValidate = order.customer.userId;
    if (userToValidate == userId) {
      return order;
    } else {
      throw boom.badRequest('is not your orderId');
    }
  }
  async findOrdersByBusinessId(businessId) {
    const orders = await models.Order.findAll({
      where: {
        state: {
          [Op.in]: ['pagada', 'pendiente_envio'],
        },
      },
      include: [
        {
          association: 'customer',
          include: [
            {
              association: 'user',
              attributes: {
                exclude: ['password', 'recoveryToken'],
              },
            },
          ],
        },
        {
          association: 'items',
          where: {
            businessId,
          },
        },
      ],
    });

    return orders;
  }
  //Servicio para obtener las ordenes filtradas por un estado
  async findOrdersByState(state) {
    const orders = await this.find();
    if (!orders) {
      throw boom.badRequest('order not found');
    }
    const ordersByState = orders.filter((order) => order.state == state);
    if (ordersByState.length == 0) {
      throw boom.badRequest(`Order in state ${state} not found`);
    }
    return ordersByState;
  }
  async update(id, changes) {
    const order = await this.findOne(id);
    const rta = await order.update(changes);
    if (changes.state === 'pagada'|| changes.state === 'pendiente_envio') {
      const orderItems = await models.OrderProduct.findAll({
        where: {
          orderId: id,
        },
      });
      for (let i = 0; i < orderItems.length; i++) {
        const product = await models.Product.findByPk(orderItems[i].productId);
        await product.update({
          stock: product.stock - orderItems[i].amount,
        });
      }

      // ── Dropshipping dispatch ────────────────────────────────────────────
      // Stock is already decremented — order confirmed on our side.
      // Fulfillment errors must NOT reverse the customer's payment: we catch
      // them, log them, and save the error so the merchant can retry from
      // the dashboard via POST /orders/:id/retry-fulfillment.
      try {
        const dispatchResult = await this.dispatchToProviders(order);
        // Persist Dropi order ID and mark as dispatched
        if (dispatchResult?.dropiOrderId) {
          await order.update({
            dropiOrderId:      dispatchResult.dropiOrderId,
            fulfillmentStatus: 'DISPATCHED',
            fulfillmentError:  null,
          });
        }
      } catch (dispatchError) {
        console.error(
          `[OrderService] Provider dispatch failed for order ${id}: ${dispatchError.message}`
        );
        try {
          await order.update({
            stateOrder:        'error_api_proveedor',
            fulfillmentStatus: 'PENDING_DROPI_FULFILLMENT',
            fulfillmentError:  dispatchError.message.slice(0, 1000),
          });
        } catch (markError) {
          console.error(
            `[OrderService] Could not mark order ${id} as error_api_proveedor: ${markError.message}`
          );
        }
      }
    }

    if (changes.state === 'pendiente_envio') {
      const customerEmail = order.customer.user.email;
      const customerName = order.customer.name;
      const mailCustomer = {
          from: config.smtpMail,
          to: `${customerEmail}`,
          subject: "Compra realizada con exito",
          html: `<p>Muchas gracias por tú compra, se ah realizado con exito</p>
          </br>
          <p>Muchas gracias Estimado(a) ${customerName} por tú compra</p>
          Queremos agradecerte por tu compra en Aynimar. <br> Tu número de orden es <strong>${id}</strong></p>
          <p>Queremos que sepas que estamos procesando tu compra y que te enviaremos una confirmación de envío o entrega tan pronto como sea posible. Si tienes alguna pregunta o inquietud, no dudes en ponerte en contacto con nuestro equipo de soporte en https://www.aynimar.com/contact.</p>
          <p>Gracias por confiar en nosotros y por elegir Aynimar para tus compras. Esperamos que disfrutes de tus productos.</p>
          <p>Saludos cordiales,</p>
          <p>El equipo de Aynimar</p>
          <img src="https://www.aynimar.com/_next/static/media/logo-Aynimar.c247031e.svg" alt="Aynimar-logo">
          <p>Hasta mientras estaremos preparando tu pedido para enviartelo, y muy pronto uno de nuestros agentes se comunicará con tigo</p>
          <p>Recuerda que tambien puedes pedir devolucion a nuestro equipo antes de que la entrega sea realizada y crear una disputa en caso de que quieras devolver tú producto, comunicate con nosotros en https://www.aynimar.com/contact</p>
          `,
        }
      // await this.sendMail(mailCustomer);
      try {
          await sendMail(mailCustomer);
          console.log('Welcome email sent successfully via Brevo');
        } catch (emailError) {
          console.error('Failed to send welcome email:', emailError);
        }
      console.log('Email del Cliente:', customerEmail);

      const businessIds = [...new Set(order.items.map(item => item.businessId))];
      const businesses = await models.Business.findAll({
        where: {
          id: {
            [Op.in]: businessIds
          }
        },
        include: {
          association: 'businessOwner',
          include: {
            association: 'user',
            attributes: ['email']
          }
        }
      });
      const ownersData = {};
      for (const item of order.items) {
        const business = businesses.find(b => b.id === item.businessId);
        if (business && business.businessOwner && business.businessOwner.user) {
          const ownerEmail = business.businessOwner.user.email;
          const ownerName = business.businessOwner.name;
          const businessId = business.id;
          const businessName = business.name;
          if (!ownersData[ownerEmail]) {
            ownersData[ownerEmail] = {
              email: ownerEmail,
              name: ownerName,
              businesses: {} 
            };
          }
          if (!ownersData[ownerEmail].businesses[businessId]) {
            ownersData[ownerEmail].businesses[businessId] = {
              name: businessName,
              products: []
            };
          }
          ownersData[ownerEmail].businesses[businessId].products.push({
            name: item.name,
            amount: item.OrderProduct.amount,
            price: item.price
          });
        }
      }
      for (const ownerEmail in ownersData) {
        const owner = ownersData[ownerEmail];
        const businessesHtml = Object.values(owner.businesses).map(business => {
          // const productListHtml = business.products
          //   .map(p => `<li>${p.amount} x ${p.name} - (Precio unitario: $${p.price / 100})</li>`)
          //   .join('');
          const productListHtml = business.products
            .map(p => `<li>${p.amount} x ${p.name} - (Precio unitario: $${p.price.toFixed(2)})</li>`)
            .join('');

          return `
            <h4>Negocio: ${business.name}</h4>
            <ul>
              ${productListHtml}
            </ul>
          `;
        }).join('<hr style="border: 1px solid #eee; margin: 20px 0;">');

        const mailForOwner = {
          from: config.smtpMail,
          to: owner.email,
          subject: `¡Nueva venta! Has recibido un pedido (Orden #${id})`,
          html: `
            <p>¡Hola, ${owner.name}!</p>
            <p>Has recibido una venta para los siguientes productos en la orden <strong>#${id}</strong>, agrupados por cada uno de tus negocios:</p>
            ${businessesHtml}
            <p>Por favor, prepara los productos para el envío. Puedes ver los detalles completos de la orden en tu panel de vendedor.</p>
            <p>Saludos cordiales,</p>
            <p>El equipo de Aynimar</p>
            <img src="https://www.aynimar.com/_next/static/media/logo-Aynimar.c247031e.svg" alt="Aynimar-logo">
          `
        };

        // await this.sendMail(mailForOwner);
        try {
          await sendMail(mailForOwner);
          console.log('Welcome email sent successfully via Brevo');
        } catch (emailError) {
          console.error('Failed to send welcome email:', emailError);
        }
      }
      console.log('Emails enviados a los dueños de negocios:', Object.keys(ownersData)); 
    }

    return {
      id,
      changes,
      rta,
    };
  }
  async delete(id) {
    const model = await this.findOne(id);
    await model.destroy();
    return { rta: true };
  }
  // Items
  async findOneItem(id) {
    const item = await models.OrderProduct.findByPk(id);
    return item;
  }
  async addItem(data) {
    const newItem = await models.OrderProduct.create(data);
    return newItem;
  }
  async updateItem(id, changes) {
    const item = await this.findOneItem(id);
    const rta = await item.update(changes);
    return {
      id,
      changes,
      rta,
    };
  }
  async deleteItem(id) {
    const item = await this.findOneItem(id);
    await item.destroy();
    return { rta: true };
  }

  /**
   * Dispatches fulfillment orders to external dropshipping providers.
   *
   * Iterates over the order's items. Any item whose Product has a
   * `sourceProvider` of 'dropi' or 'effi' is grouped and sent to the
   * corresponding adapter. Items without a `sourceProvider` (own stock) are
   * silently skipped — they fulfil through the normal warehouse workflow.
   *
   * This method THROWS if any provider call fails, so the caller in update()
   * can decide how to handle it (mark order, log, etc.) without hiding errors.
   *
   * @param {Order} order  Sequelize Order instance with `items` and `customer` preloaded
   */
  async dispatchToProviders(order) {
    // ── 1. Group dropship items by provider ──────────────────────────────────
    const byProvider = {};

    for (const item of order.items) {
      const { sourceProvider, externalId } = item;
      if (!sourceProvider || !externalId) continue;      // own-stock product

      if (sourceProvider !== 'dropi' && sourceProvider !== 'effi') {
        console.warn(
          `[Dispatch] Unknown sourceProvider "${sourceProvider}" on product ${item.id} — skipped`
        );
        continue;
      }

      if (!byProvider[sourceProvider]) byProvider[sourceProvider] = [];
      byProvider[sourceProvider].push({
        externalId,
        quantity: item.OrderProduct.amount,
      });
    }

    if (Object.keys(byProvider).length === 0) return; // nothing to dispatch

    // ── 2. Build a normalized shipping address from the Customer record ──────
    const c = order.customer;
    const shippingAddress = {
      name:              `${c.name} ${c.lastName}`.trim(),
      phone:             c.phone    ?? '',
      email:             c.user?.email ?? '',
      address:           c.streetAddress ?? '',
      city:              c.city     ?? '',
      province:          c.province ?? '',
      postalCode:        c.postalCode ?? '',
      countryOfResidence: c.countryOfResidence ?? '',
    };

    // ── 3. Fire each provider and collect errors ─────────────────────────────
    // We iterate sequentially rather than Promise.all so that a Dropi failure
    // doesn't silently suppress an Effi success logged after it.
    const errors = [];

    let dropiOrderId = null;

    if (byProvider.dropi) {
      try {
        const result = await createOrderInDropi({
          referenceId:     `AYNIMAR-${order.id}`,
          items:           byProvider.dropi,
          shippingAddress,
        });
        dropiOrderId = result.externalOrderId ?? null;
        console.log(
          `[Dispatch] Dropi order created for Aynimar #${order.id}: ${dropiOrderId}`
        );
      } catch (err) {
        errors.push(`dropi: ${err.message}`);
        console.error(`[Dispatch] Dropi error for order ${order.id}:`, err.message);
      }
    }

    if (byProvider.effi) {
      try {
        const { externalOrderId } = await createOrderInEffi({
          referenceId:     `AYNIMAR-${order.id}`,
          items:           byProvider.effi,
          shippingAddress,
        });
        console.log(
          `[Dispatch] Effi order created for Aynimar #${order.id}: ${externalOrderId}`
        );
      } catch (err) {
        errors.push(`effi: ${err.message}`);
        console.error(`[Dispatch] Effi error for order ${order.id}:`, err.message);
      }
    }

    // ── 4. Surface aggregated errors so update() can mark the order ──────────
    if (errors.length > 0) {
      throw new Error(`Provider dispatch failed — ${errors.join('; ')}`);
    }

    return { dropiOrderId };
  }

  /**
   * Retries Dropi fulfillment for an order stuck in 'error_api_proveedor' /
   * 'PENDING_DROPI_FULFILLMENT'. On success updates dropiOrderId + status;
   * on failure updates fulfillmentError with the new error message.
   */
  async retryFulfillment(id) {
    const order = await this.findOne(id);
    if (!order) throw boom.notFound('Order not found');

    if (order.fulfillmentStatus === 'DISPATCHED') {
      throw boom.conflict(
        `Order ${id} is already dispatched to Dropi (dropiOrderId: ${order.dropiOrderId})`
      );
    }

    try {
      const dispatchResult = await this.dispatchToProviders(order);
      if (dispatchResult?.dropiOrderId) {
        await order.update({
          dropiOrderId:      dispatchResult.dropiOrderId,
          fulfillmentStatus: 'DISPATCHED',
          fulfillmentError:  null,
          stateOrder:        'en_preparacion',
        });
      }
      return {
        success:     true,
        dropiOrderId: dispatchResult?.dropiOrderId ?? null,
        orderId:     id,
      };
    } catch (err) {
      await order.update({
        fulfillmentStatus: 'PENDING_DROPI_FULFILLMENT',
        fulfillmentError:  err.message.slice(0, 1000),
      });
      throw boom.badGateway(`Retry failed: ${err.message}`);
    }
  }

  /**
   * Fetches the current Dropi delivery status and saves it locally.
   * Returns { deliveryStatus, dropiOrderId }.
   */
  async syncDropiDeliveryStatus(id) {
    const order = await this.findOne(id);
    if (!order) throw boom.notFound('Order not found');
    if (!order.dropiOrderId) {
      throw boom.badRequest('This order has no Dropi order ID — dispatch it first.');
    }

    const deliveryStatus = await fetchDropiOrderStatus(order.dropiOrderId);

    if (deliveryStatus) {
      // Mirror Dropi status into our stateOrder when we can map it
      const stateMap = {
        'entregado':    'entregado',
        'Entregado':    'entregado',
        'en transito':  'en_transito',
        'En transito':  'en_transito',
        'En tránsito':  'en_transito',
        'enviado':      'enviado',
        'Enviado':      'enviado',
      };
      const mappedState = stateMap[deliveryStatus];

      const update = { deliveryStatus };
      if (mappedState) update.stateOrder = mappedState;
      await order.update(update);
    }

    return { dropiOrderId: order.dropiOrderId, deliveryStatus: deliveryStatus ?? order.deliveryStatus };
  }

  /**
   * Atomic checkout: validates the cart, recalculates totals from DB prices,
   * redeems green credits, and transitions the order out of 'carrito' state.
   *
   * Everything runs inside a single Sequelize transaction. Any failure
   * (insufficient stock, insufficient credits, DB error) triggers a full
   * rollback — no credits are lost and the order stays in 'carrito'.
   *
   * Credit exchange rate: 1 credit = 1 unit of currency (e.g. $1 USD).
   * `creditsToApply` is capped at Math.floor(subtotal) so a user can never
   * overpay with credits (partial-credit + external payment is supported).
   *
   * @param {number} orderId
   * @param {number} userId           The authenticated user's id (from JWT sub)
   * @param {number} creditsToApply   Non-negative integer — credits the user wants to use
   * @returns {Promise<CheckoutSummary>}
   */
  async checkout(orderId, userId, creditsToApply = 0) {
    const walletService = new WalletService();

    return sequelize.transaction(async (t) => {

      // ── 1. Load order with a row-level lock ────────────────────────────────
      // The lock prevents a second concurrent checkout on the same cart from
      // reading a stale state while this transaction is in progress.
      const order = await models.Order.findByPk(orderId, {
        include: [
          { association: 'customer', include: ['user'] },
          { association: 'items' },
        ],
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      if (!order) throw boom.notFound('Order not found');

      // ── 2. Guard: only the cart owner can check out ────────────────────────
      if (!order.customer) {
        throw boom.badRequest('This order has no customer. Associate it first.');
      }
      if (order.customer.userId !== userId) {
        throw boom.forbidden('You are not allowed to check out this order');
      }

      // ── 3. Guard: only carts can be checked out ────────────────────────────
      if (order.state !== 'carrito') {
        throw boom.conflict(
          `Order is already in state "${order.state}" and cannot be checked out again`
        );
      }

      // ── 4. Guard: cart must have at least one item ─────────────────────────
      if (!order.items || order.items.length === 0) {
        throw boom.badRequest('Cannot check out an empty cart');
      }

      // ── 5. Re-fetch products with authoritative DB prices + row lock ────────
      // We never trust the price cached on the cart item — we read from
      // the products table inside this transaction so the price cannot change
      // between our read and the moment we commit.
      const productIds = order.items.map((item) => item.id);
      const products = await models.Product.findAll({
        where: { id: productIds, isDeleted: false },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      if (products.length !== productIds.length) {
        const foundIds = new Set(products.map((p) => p.id));
        const missing = productIds.filter((id) => !foundIds.has(id));
        throw boom.badRequest(
          `The following products are no longer available: ${missing.join(', ')}`
        );
      }

      const productMap = new Map(products.map((p) => [p.id, p]));

      // ── 6. Validate stock and calculate subtotal ───────────────────────────
      let subtotal = 0;

      for (const item of order.items) {
        const product = productMap.get(item.id);
        const quantity = item.OrderProduct.amount;

        // Stock can be null for unlimited/dropship products — skip the check.
        if (product.stock !== null && product.stock < quantity) {
          throw boom.conflict(
            `Insufficient stock for "${product.name}". ` +
            `Available: ${product.stock}, requested: ${quantity}`
          );
        }

        subtotal += product.price * quantity;
      }

      // Round to 2 decimal places to avoid float drift (e.g. 10.999999...)
      subtotal = parseFloat(subtotal.toFixed(2));

      // ── 7. Calculate credit discount ───────────────────────────────────────
      // Cap credits at floor(subtotal): credits are integers, so we cannot
      // apply 5 credits against a $4.99 item (that would be a 1¢ gain).
      const maxCredits = Math.floor(subtotal);
      const creditsUsed = Math.min(creditsToApply, maxCredits);
      const amountToPay = parseFloat((subtotal - creditsUsed).toFixed(2));

      // ── 8. Redeem credits — inside the same transaction ────────────────────
      // If the wallet has insufficient balance, redeemCredits throws a
      // 402 paymentRequired and the entire transaction rolls back automatically.
      if (creditsUsed > 0) {
        await walletService.redeemCredits(userId, creditsUsed, { transaction: t });
      }

      // ── 9. Transition order state ──────────────────────────────────────────
      // fully covered by credits → no external payment needed, hand off to business
      // partially covered      → awaiting external payment method
      const newStateOrder = amountToPay === 0
        ? 'comprado_pendiente_negocio'
        : 'comprado_pendiente_pago';

      const paymentMethod = creditsUsed > 0 && amountToPay === 0
        ? 'green_credits'
        : creditsUsed > 0
          ? 'credits_partial'
          : null;

      await order.update(
        { state: 'comprada', stateOrder: newStateOrder, paymentMethod },
        { transaction: t }
      );

      // ── 10. Return checkout summary ────────────────────────────────────────
      return {
        orderId,
        subtotal,
        creditsApplied: creditsUsed,
        amountToPay,
        stateOrder: newStateOrder,
        paymentMethod,
        itemCount: order.items.length,
      };
    });
  }
}
module.exports = OrderService;
