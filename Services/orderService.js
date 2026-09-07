/* eslint-disable no-console */
const boom = require('@hapi/boom');
const sequelize = require('../libs/sequelize');
const { models } = sequelize;
const { Op } = require('sequelize');
const WalletService = require('./walletService');
const { computeOrderTotals, computeCreditRedemption, isTerminalStateOrder } = require('./orderTotals');
const { createOrderInDropi, fetchDropiOrderStatus } = require('../integrations/dropi/dropiAdapter');
const { createOrderInEffi }  = require('../integrations/effi/effiAdapter');
const { sendTelegramNotification } = require('../utils/telegramNotify');
const { buildDispatchDescription } = require('../utils/variantAdapter');

const { config } = require('./../config/config');
const sendMail = require('../utils/sendMail');
const { cartRecoveryQueue } = require('../libs/cartRecoveryQueue');

const CART_RECOVERY_DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours

// Fase B (B3): intentos totales de despacho por orden. El 1º lo hace la FASE 2
// síncrona de _finalizeAndDispatch; los restantes, el dropiRetryWorker.
const MAX_DISPATCH_ATTEMPTS = 4;


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
  async createGuestOrder(guestEmail) {
    const newGuestOrder = await models.Order.create({});

    // Enqueue the abandoned-cart recovery job with a 2-hour delay.
    // The worker will verify the order is still in 'carrito' state before sending.
    //
    // Fire-and-forget on purpose: cart recovery is a secondary feature and
    // must never make order creation wait on Redis. Non-fatal: email recovery
    // failing (or Redis being unreachable) must not block order creation —
    // `.catch()` here (no `await`) is what actually guarantees that, since an
    // awaited call would still block this request until Redis's own bounded
    // retry/timeout gives up (see libs/cartRecoveryQueue.js `queueConnection`).
    cartRecoveryQueue.add(
      'recover-cart',
      { orderId: newGuestOrder.id, guestEmail: guestEmail || null },
      {
        delay: CART_RECOVERY_DELAY_MS,
        jobId: `cart-${newGuestOrder.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      }
    ).catch((queueErr) => {
      console.error('[CartRecovery] Failed to enqueue job:', queueErr.message);
    });

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

    // FK safety check — prevents a DB constraint violation if the AI sends
    // a stale, hallucinated, or default product_id that no longer exists.
    const productoExiste = await models.Product.findByPk(data.productId, {
      attributes: ['id'],
    });
    if (!productoExiste) {
      throw boom.notFound(`Producto ${data.productId} no encontrado en inventario. Lo siento, ese producto no está disponible en este momento.`);
    }

    const newItem = await models.OrderProduct.create(data);

    // Reset the 2-hour countdown each time an item is added (idempotent via jobId).
    // If guestEmail is now available, update it in the new job payload.
    //
    // Fire-and-forget on purpose (see createGuestOrder() above) — adding an
    // item to the cart must never wait on Redis. The whole getJob→remove→add
    // sequence runs detached from the request; any failure along the way
    // (including Redis being unreachable) is caught and logged, never thrown.
    (async () => {
      const jobId = `cart-${data.orderId}`;
      const existing = await cartRecoveryQueue.getJob(jobId);
      if (existing) await existing.remove();

      await cartRecoveryQueue.add(
        'recover-cart',
        {
          orderId: data.orderId,
          guestEmail: data.guestEmail || (existing?.data?.guestEmail) || null,
        },
        {
          delay: CART_RECOVERY_DELAY_MS,
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
        }
      );
    })().catch((queueErr) => {
      console.error('[CartRecovery] Failed to re-enqueue job:', queueErr.message);
    });

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

    // La orden ya fue asociada a un cliente — ya no es un carrito guest.
    // Respondemos 404 (no 403) para que el frontend limpie el oi en localStorage
    // y no reintente indefinidamente con un ID de orden ya vinculado.
    if (order.customerId) {
      throw boom.notFound('Order not found');
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
        // Fase A (A2): se añade 'comprada' → antes las órdenes pagadas 100%
        // con créditos (state='comprada') no aparecían en el dashboard del
        // negocio y quedaban sin despachar. El payment_status viaja en el
        // modelo para que el dashboard muestre pendiente / pagado.
        state: {
          [Op.in]: ['comprada', 'pagada', 'pendiente_envio'],
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
  // Fase A (A2): estados de fulfillment terminales — una vez ahí, sólo un admin
  // puede moverlos (evita que un business_owner "des-entregue" o "des-cancele").
  _assertStateOrderTransition(current, next, userRole) {
    if (!next || current === next) return;
    if (isTerminalStateOrder(current) && userRole !== 'admin') {
      throw boom.forbidden(
        `La orden está en estado "${current}" (terminal); sólo un admin puede cambiarlo.`
      );
    }
  }

  // Fase B (B4): update() ya NO descuenta stock ni despacha. Eso vive ahora en
  // _finalizeAndDispatch() (transacción) + _dispatchOrder() (post-commit).
  // update() sólo aplica cambios de campos con el guard de transición.
  async update(id, changes, userRole = null) {
    const order = await this.findOne(id);
    if (changes.stateOrder) {
      this._assertStateOrderTransition(order.stateOrder, changes.stateOrder, userRole);
    }
    const rta = await order.update(changes);
    return { id, changes, rta };
  }

  // ── _finalizeAndDispatch — Fase B (B3/B4) ──────────────────────────────────
  // Confirma una orden (COD hoy; comprobante aprobado en Fase C):
  //   FASE 1 (transacción DB): lock de orden → transición atómica desde
  //     'carrito' → verificar+descontar stock (guard anti-negativo/TOCTOU) →
  //     persistir totales/estado → commit.
  //   FASE 2 (post-commit, sin txn): despacho externo a proveedores + emails.
  //     Un fallo aquí NUNCA revierte la orden — queda para el worker de retry.
  //
  // Idempotente: dos peticiones concurrentes → la 2ª bloquea en el lock, luego
  // ve state != 'carrito' → 409. No hay doble despacho.
  //
  // @param {number} orderId
  // @param {{ userId?: number, paymentMethod?: string, paymentStatus?: string }} opts
  //   userId presente ⇒ se valida propiedad (acción del cliente, ej. confirmCod).
  //   userId ausente ⇒ sin chequeo de propiedad (acción de staff ya autorizada
  //   por el guard de rol en la ruta, ej. aprobación de comprobante DeUna).
  //   paymentMethod/paymentStatus — Paso 11 (DeUna): default 'cod'/'pending'
  //   preserva EXACTAMENTE el comportamiento previo de confirmCod. Quien
  //   confirma un comprobante aprobado pasa 'deuna'/'paid' explícitamente.
  async _finalizeAndDispatch(orderId, { userId, paymentMethod = 'cod', paymentStatus = 'pending' } = {}) {
    // ── FASE 1: transacción DB (rápida, sin llamadas externas) ─────────────
    await sequelize.transaction(async (t) => {
      // Lock SÓLO la fila de la orden — `SELECT ... FROM orders WHERE id=? FOR
      // UPDATE`, sin joins. Serializa confirmaciones concurrentes: la 2ª
      // petición bloquea aquí hasta el commit de la 1ª y luego ve el estado ya
      // avanzado.
      const ord = await models.Order.findByPk(orderId, {
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
      if (!ord) throw boom.notFound('Orden no encontrada');

      // Propiedad primero (antes que el estado): un no-dueño nunca recibe
      // información sobre la orden (403, no 409).
      if (userId != null) {
        const customer = ord.customerId
          ? await models.Customer.findByPk(ord.customerId, {
              attributes: ['id', 'userId'],
              transaction: t,
            })
          : null;
        if (!customer || customer.userId !== userId) {
          throw boom.forbidden('Esta orden no te pertenece');
        }
      }

      // Transición atómica. Estados de entrada válidos:
      //   - 'carrito'                              → COD directo
      //   - 'comprada' + 'comprado_pendiente_pago' → créditos parciales ya
      //     aplicados por checkout() (que NO descuenta stock ni despacha);
      //     el cliente completa el saldo con COD. No se re-tocan los créditos.
      const fromPartialCredit =
        ord.state === 'comprada' && ord.stateOrder === 'comprado_pendiente_pago';
      if (ord.state !== 'carrito' && !fromPartialCredit) {
        throw boom.conflict(
          `La orden no se puede confirmar (estado: ${ord.state} / ${ord.stateOrder})`
        );
      }

      const items = await models.OrderProduct.findAll({
        where: { orderId: ord.id },
        transaction: t,
      });
      if (items.length === 0) {
        throw boom.badRequest('No puedes confirmar un carrito vacío');
      }

      // Stock: re-leer cada producto CON lock, verificar y descontar dentro de
      // la transacción (cierra la ventana TOCTOU y evita stock negativo).
      const lineItems = [];
      for (const it of items) {
        const product = await models.Product.findByPk(it.productId, {
          lock: t.LOCK.UPDATE,
          transaction: t,
        });
        if (!product || product.isDeleted) {
          throw boom.conflict('Un producto de la orden ya no está disponible.');
        }
        const qty = it.amount;
        if (product.stock !== null) {
          if (product.stock < qty) {
            throw boom.conflict(
              `Stock insuficiente para "${product.name}". Disponible: ${product.stock}, pedido: ${qty}`
            );
          }
          await product.update({ stock: product.stock - qty }, { transaction: t });
        }
        lineItems.push({ price: product.price, qty });
      }

      // Totales: para créditos parciales, checkout() ya los fijó — no se
      // recalculan (perderíamos el contexto del crédito aplicado).
      const totals = fromPartialCredit
        ? {}
        : computeOrderTotals(lineItems);

      await ord.update(
        {
          state:                 'pendiente_envio',
          paymentMethod,
          paymentStatus,
          ...totals,
          fulfillmentStatus:     'PENDING_DISPATCH',
          fulfillmentRetryCount: 0,
        },
        { transaction: t }
      );
    });

    // ── FASE 2: post-commit ────────────────────────────────────────────────
    // Se re-carga la orden FUERA de la transacción (la instancia cargada dentro
    // no debe usarse para escrituras tras el commit). Si el proceso muere aquí,
    // la orden queda PENDING_DISPATCH y el dropiRetryWorker la retoma.
    const order = await this.findOne(orderId);
    await this._dispatchOrder(order);
    this._notifyOrderConfirmed(order).catch((e) =>
      console.error(`[OrderService] notify order ${orderId} failed: ${e.message}`)
    );

    return {
      orderId:           Number(orderId),
      paymentMethod:     order.paymentMethod,
      paymentStatus:     order.paymentStatus,
      subtotal:          order.subtotal,
      total:             order.total,
      state:             order.state,
      stateOrder:        order.stateOrder,
      fulfillmentStatus: order.fulfillmentStatus,
    };
  }

  // ── _dispatchOrder — despacho externo, SIEMPRE fuera de transacción ────────
  // Único punto de despacho: lo llaman la FASE 2 de _finalizeAndDispatch y el
  // dropiRetryWorker. Nunca lanza (salvo error de programación).
  //
  // Claim atómico: `fulfillmentRetryCount` funciona como optimistic-lock. Sólo
  // un actor incrementa el contador y despacha un intento a la vez. Si el
  // proceso muere durante el intento, la orden sigue PENDING_DISPATCH /
  // PENDING_DROPI_FULFILLMENT con dropiOrderId=null y el worker la retoma en el
  // siguiente tick (no queda ningún estado "atascado").
  //
  // @returns {{status:'DISPATCHED'|'MANUAL_LOGISTICS'|'RETRY_PENDING'|'FAILED'|'SKIPPED', dropiOrderId?:string}}
  async _dispatchOrder(order) {
    if (order.dropiOrderId) {
      if (order.fulfillmentStatus !== 'DISPATCHED') {
        await order.update({ fulfillmentStatus: 'DISPATCHED', fulfillmentError: null }).catch(() => {});
      }
      return { status: 'DISPATCHED', dropiOrderId: order.dropiOrderId };
    }

    const prevCount = order.fulfillmentRetryCount ?? 0;
    const attempt = prevCount + 1;
    const [claimed] = await models.Order.update(
      { fulfillmentRetryCount: attempt },
      {
        where: {
          id:                    order.id,
          fulfillmentRetryCount: prevCount,
          dropiOrderId:          null,
          fulfillmentStatus:     { [Op.in]: ['PENDING_DISPATCH', 'PENDING_DROPI_FULFILLMENT'] },
        },
      }
    );
    if (claimed === 0) {
      console.log(`[OrderService] Order ${order.id}: dispatch ya reclamado/completado por otro proceso — omitido`);
      return { status: 'SKIPPED' };
    }
    order.fulfillmentRetryCount = attempt;

    try {
      const dispatchResult = await this.dispatchToProviders(order);
      if (dispatchResult?.dropiOrderId) {
        await order.update({
          dropiOrderId:      dispatchResult.dropiOrderId,
          fulfillmentStatus: 'DISPATCHED',
          fulfillmentError:  null,
          stateOrder:        'en_preparacion',
        });
        return { status: 'DISPATCHED', dropiOrderId: dispatchResult.dropiOrderId };
      }
      if (dispatchResult === undefined) {
        await order.update({ fulfillmentStatus: 'MANUAL_LOGISTICS', fulfillmentError: null });
        console.log(`[OrderService] Order ${order.id} sin ítems Dropi — MANUAL_LOGISTICS`);
        return { status: 'MANUAL_LOGISTICS' };
      }
      return { status: 'SKIPPED' };
    } catch (dispatchError) {
      const exhausted = attempt >= MAX_DISPATCH_ATTEMPTS;
      console.error(
        `[OrderService] dispatch falló para orden ${order.id} (intento ${attempt}/${MAX_DISPATCH_ATTEMPTS}): ${dispatchError.message}`
      );
      await order.update({
        stateOrder:        'error_api_proveedor',
        fulfillmentStatus: exhausted ? 'FAILED_DROPI_FULFILLMENT' : 'PENDING_DROPI_FULFILLMENT',
        fulfillmentError:  dispatchError.message.slice(0, 1000),
      }).catch((e) =>
        console.error(`[OrderService] no se pudo marcar error en orden ${order.id}: ${e.message}`)
      );

      if (exhausted) {
        sendTelegramNotification(
          `🚨 <b>FALLO DROPI — Orden #${order.id}</b>\n` +
          `Agotados ${MAX_DISPATCH_ATTEMPTS} intentos de despacho.\n` +
          `Error: ${dispatchError.message.slice(0, 300)}\n` +
          `⚠️ Intervención manual: POST /orders/${order.id}/retry-fulfillment`
        ).catch((tErr) => console.error('[OrderService] Telegram alert failed:', tErr.message));
      }
      return { status: exhausted ? 'FAILED' : 'RETRY_PENDING' };
    }
  }

  // Emails de confirmación (cliente + dueños de negocio). Best-effort.
  async _notifyOrderConfirmed(order) {
    const id = order.id;
    {
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

  // ── Mutación de items de carrito con autorización — Fase A (A3) ──────────────
  // Reemplaza el uso directo de updateItem/deleteItem desde las rutas públicas.
  // Reglas:
  //   - la orden debe estar en state 'carrito' (no se toca una orden en pago/envío)
  //   - carrito guest (customerId null): cualquiera con el id del item (igual que
  //     el resto del flujo guest, que se apoya en el id de orden en localStorage)
  //   - carrito de un cliente: sólo ese cliente, con JWT válido
  async _loadItemOrder(itemId) {
    const item = await models.OrderProduct.findByPk(itemId);
    if (!item) throw boom.notFound('Item de carrito no encontrado');
    const order = await models.Order.findByPk(item.orderId, {
      include: [{ association: 'customer', attributes: ['id', 'userId'] }],
    });
    if (!order) throw boom.notFound('Orden no encontrada');
    return { item, order };
  }

  _assertCartMutable(order, userId) {
    if (order.state !== 'carrito') {
      throw boom.conflict('Esta orden ya no es un carrito editable');
    }
    if (order.customerId) {
      if (!userId || !order.customer || order.customer.userId !== userId) {
        throw boom.forbidden('No puedes modificar el carrito de otro usuario');
      }
    }
  }

  async updateCartItem(itemId, changes, userId = null) {
    if (changes.amount == null) {
      throw boom.badRequest('Falta "amount" para actualizar el item');
    }
    const { item, order } = await this._loadItemOrder(itemId);
    this._assertCartMutable(order, userId);
    await item.update({ amount: changes.amount }); // sólo cantidad — nunca orderId/productId
    return { id: itemId, amount: item.amount, rta: true };
  }

  async deleteCartItem(itemId, userId = null) {
    const { item, order } = await this._loadItemOrder(itemId);
    this._assertCartMutable(order, userId);
    await item.destroy();
    return { rta: true };
  }

  // ── Confirmar pedido Contra Entrega — Fase A (A2) / Fase B (B3/B4) ─────────
  // Reemplaza el antiguo PATCH /orders/:id {state:'pendiente_envio'}.
  // Toda la lógica (transacción + stock + despacho idempotente) vive en
  // _finalizeAndDispatch.
  async confirmCod(orderId, userId) {
    return this._finalizeAndDispatch(orderId, { userId });
  }

  // ── Confirmar pago DeUna aprobado — Paso 11 ────────────────────────────────
  // Llamado ÚNICAMENTE por PaymentProofService.approveProof(), después de que
  // un admin/business_owner aprueba explícitamente un comprobante — nunca
  // automáticamente. Reutiliza el mismo _finalizeAndDispatch (lock + guard de
  // transición de estado + stock + despacho idempotente) que confirmCod, sin
  // chequeo de propiedad (userId ausente: acción de staff, ya autorizada por
  // el guard de rol en la ruta) y con paymentMethod/paymentStatus explícitos.
  async confirmPaymentProof(orderId, { paymentMethod, paymentStatus }) {
    return this._finalizeAndDispatch(orderId, { paymentMethod, paymentStatus });
  }

  /**
   * Pre-flight validation for dropi_items before any API call is made.
   * Runs synchronously — no network, no DB. Throws on the first batch of errors
   * so dispatchToProviders fails fast with a clear, actionable message.
   *
   * Rules (validated against productSchema.js Joi contract):
   *   - dropiItems[n].id  must be a non-empty string
   *   - dropiItems[n].qty must be a positive integer when isBundle=true
   *
   * @param {Array} items  order.items with Product data pre-loaded
   */
  _validateDispatchItems(items) {
    const errors = [];

    for (const item of items) {
      if (!Array.isArray(item.dropiItems) || item.dropiItems.length === 0) continue;

      item.dropiItems.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') {
          errors.push(`Product ${item.id}: dropiItems[${i}] is not an object`);
          return;
        }
        if (!entry.id || typeof entry.id !== 'string' || entry.id.trim() === '') {
          errors.push(`Product ${item.id}: dropiItems[${i}].id is missing or empty`);
        }
        if (item.isBundle === true) {
          const qty = entry.qty ?? 1;
          if (!Number.isInteger(qty) || qty < 1) {
            errors.push(
              `Product ${item.id}: dropiItems[${i}].qty must be a positive integer (got ${JSON.stringify(qty)})`,
            );
          }
        }
      });

      if (item.isBundle === true && item.dropiItems.length < 2) {
        console.warn(
          `[Dispatch][WARN] Product ${item.id} has isBundle=true but only 1 dropiItem — ` +
          'verify this is intentional (bundle should have 2+ different Dropi IDs)',
        );
      }
    }

    if (errors.length > 0) {
      const detail = errors.join(' | ');
      console.error(`[Dispatch][PRE-FLIGHT FAILED] ${detail}`);
      throw new Error(`Dispatch pre-flight validation failed: ${detail}`);
    }

    console.log(`[Dispatch][PRE-FLIGHT OK] ${items.length} item(s) validated`);
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
    // ── Idempotencia (Fase B / B3): si ya hay orden en Dropi, no recrear ────
    if (order.dropiOrderId) {
      console.log(`[Dispatch] Order ${order.id} ya tiene dropiOrderId ${order.dropiOrderId} — no se recrea`);
      return { dropiOrderId: order.dropiOrderId };
    }

    // ── 0. Pre-flight: validate dropi_items structure before any API call ────
    this._validateDispatchItems(order.items);

    // ── 1. Group dropship items by provider ──────────────────────────────────
    const byProvider = {};

    for (const item of order.items) {
      // ── dropiItems mode: bundle OR variant ────────────────────────────────────
      if (Array.isArray(item.dropiItems) && item.dropiItems.length > 0) {
        if (!byProvider.dropi) byProvider.dropi = [];

        if (item.isBundle === true) {
          // BUNDLE: dispatch ALL components × order quantity.
          // E.g. customer orders 2× a bundle {A×1 + B×1} → dispatches A×2 + B×2.
          const bundleDesc = buildDispatchDescription(item, null);
          for (const bundleItem of item.dropiItems) {
            if (!bundleItem.id) continue;
            byProvider.dropi.push({
              externalId:          String(bundleItem.id),
              quantity:            (bundleItem.qty ?? 1) * item.OrderProduct.amount,
              dispatchDescription: bundleDesc,
            });
          }
          console.log(`[Dispatch] Bundle "${bundleDesc}" expanded to ${item.dropiItems.length} Dropi items`);
        } else {
          // VARIANT: dispatch only the customer-selected dropi ID.
          // Falls back to the first variant if the selection was not stored.
          const selectedId = item.OrderProduct?.selectedDropiId || item.dropiItems[0]?.id;
          if (selectedId) {
            const variantDesc = buildDispatchDescription(item, item.OrderProduct?.selectedDropiId ?? null);
            byProvider.dropi.push({
              externalId:          String(selectedId),
              quantity:            item.OrderProduct.amount,
              dispatchDescription: variantDesc,
            });
            console.log(`[Dispatch] Variant "${variantDesc}" → dropi_id=${selectedId}`);
          } else {
            console.warn(`[Dispatch] Variant product ${item.id} has no selectedDropiId and no fallback — skipped`);
          }
        }
        continue;
      }

      // ── Single-product Dropi dispatch ────────────────────────────────────────
      // dropiProductId (manually linked) takes priority over sourceProvider+externalId
      const dropiId = item.dropiProductId || (item.sourceProvider === 'dropi' ? item.externalId : null);
      if (dropiId) {
        if (!byProvider.dropi) byProvider.dropi = [];
        byProvider.dropi.push({
          externalId:          dropiId,
          quantity:            item.OrderProduct.amount,
          dispatchDescription: item.name || String(dropiId),
        });
        continue;
      }

      if (item.sourceProvider === 'effi' && item.externalId) {
        if (!byProvider.effi) byProvider.effi = [];
        byProvider.effi.push({ externalId: item.externalId, quantity: item.OrderProduct.amount });
        continue;
      }

      if (item.sourceProvider && item.sourceProvider !== 'dropi' && item.sourceProvider !== 'effi') {
        console.warn(
          `[Dispatch] Unknown sourceProvider "${item.sourceProvider}" on product ${item.id} — skipped`
        );
      }
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
        const customerName = order.customer
          ? `${order.customer.name ?? ''} ${order.customer.lastName ?? ''}`.trim()
          : 'Invitado';
        const itemLines = byProvider.dropi
          .map((d) => `  • ${d.dispatchDescription || d.externalId} ×${d.quantity}`)
          .join('\n');
        await sendTelegramNotification(
          `✅ <b>Orden #${order.id} enviada a Dropi</b>\n` +
          `ID Dropi: <code>${dropiOrderId}</code>\n` +
          `Cliente: ${customerName}\n` +
          `Productos:\n${itemLines}`
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
   * Reintento MANUAL de despacho (endpoint POST /orders/:id/retry-fulfillment).
   * A diferencia del worker, un admin puede forzar el reintento aunque se hayan
   * agotado los intentos automáticos o la orden quede en un estado atascado:
   * resetea el contador y el estado, y vuelve a llamar a _dispatchOrder.
   */
  async retryFulfillment(id) {
    const order = await this.findOne(id);
    if (!order) throw boom.notFound('Order not found');

    // Ya existe en Dropi → sólo reconciliar el estado local.
    if (order.dropiOrderId) {
      if (order.fulfillmentStatus !== 'DISPATCHED') {
        await order.update({ fulfillmentStatus: 'DISPATCHED', fulfillmentError: null });
      }
      return { success: true, dropiOrderId: order.dropiOrderId, orderId: id, reconciled: true };
    }

    if (order.fulfillmentStatus === 'DISPATCHED') {
      throw boom.conflict(`Order ${id} is already dispatched to Dropi`);
    }

    // Reset para permitir el reintento manual (rompe cuenta agotada / atasco).
    await order.update({
      fulfillmentStatus:     'PENDING_DISPATCH',
      fulfillmentRetryCount: 0,
      fulfillmentError:      null,
    });
    order.fulfillmentStatus = 'PENDING_DISPATCH';
    order.fulfillmentRetryCount = 0;

    const r = await this._dispatchOrder(order);
    if (r.status === 'DISPATCHED') {
      return { success: true, dropiOrderId: r.dropiOrderId, orderId: id };
    }
    if (r.status === 'MANUAL_LOGISTICS') {
      return { success: true, manualLogistics: true, orderId: id };
    }
    throw boom.badGateway(`Retry falló (estado: ${r.status})`);
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
      //
      // IMPORTANT: no `include` here. `Order.belongsTo(Customer)` is optional
      // (customer_id is nullable — guest carts), so Sequelize would generate a
      // LEFT OUTER JOIN for any included association, and PostgreSQL rejects
      // `FOR UPDATE` on the nullable side of an outer join for ANY order,
      // regardless of whether that particular row actually has a customer.
      // Customer/user and cart items are loaded separately below — same
      // pattern already used (and proven) by `_finalizeAndDispatch()`.
      const order = await models.Order.findByPk(orderId, {
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      if (!order) throw boom.notFound('Order not found');

      // ── 2. Guard: only the cart owner can check out ────────────────────────
      const customer = order.customerId
        ? await models.Customer.findByPk(order.customerId, {
            include: ['user'],
            transaction: t,
          })
        : null;
      if (!customer) {
        throw boom.badRequest('This order has no customer. Associate it first.');
      }
      if (customer.userId !== userId) {
        throw boom.forbidden('You are not allowed to check out this order');
      }

      // ── 3. Guard: only carts can be checked out ────────────────────────────
      if (order.state !== 'carrito') {
        throw boom.conflict(
          `Order is already in state "${order.state}" and cannot be checked out again`
        );
      }

      // ── 4. Guard: cart must have at least one item ─────────────────────────
      const cartItems = await models.OrderProduct.findAll({
        where: { orderId: order.id },
        transaction: t,
      });
      if (cartItems.length === 0) {
        throw boom.badRequest('Cannot check out an empty cart');
      }

      // ── 5. Re-fetch products with authoritative DB prices + row lock ────────
      // We never trust the price cached on the cart item — we read from
      // the products table inside this transaction so the price cannot change
      // between our read and the moment we commit.
      const productIds = cartItems.map((item) => item.productId);
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

      // ── 6. Validate stock and calculate totals ────────────────────────────
      const lineItems = [];
      for (const item of cartItems) {
        const product = productMap.get(item.productId);
        const quantity = item.amount;

        // Stock can be null for unlimited/dropship products — skip the check.
        if (product.stock !== null && product.stock < quantity) {
          throw boom.conflict(
            `Insufficient stock for "${product.name}". ` +
            `Available: ${product.stock}, requested: ${quantity}`
          );
        }

        lineItems.push({ price: product.price, qty: quantity });
      }

      // Fórmula única de totales/IVA (Services/orderTotals.js). `subtotal` ya
      // incluye IVA (product.price = PVP final); `tax` es el desglose
      // informativo extraído hacia atrás, nunca se vuelve a sumar.
      const { subtotal, tax } = computeOrderTotals(lineItems);

      // ── 7. Calculate credit discount ───────────────────────────────────────
      // Cap credits at floor(subtotal): credits are integers, so we cannot
      // apply 5 credits against a $4.99 item (that would be a 1¢ gain). El
      // crédito descuenta directamente del subtotal (que ya incluye IVA) —
      // no genera un nuevo cálculo de impuesto sobre el saldo.
      const { creditsUsed, amountToPay } = computeCreditRedemption(subtotal, creditsToApply);

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

      // Estado de pago: cubierto 100% con créditos → 'paid'; si queda saldo
      // externo por pagar, sigue 'pending'.
      const paymentStatus = amountToPay === 0 ? 'paid' : 'pending';

      await order.update(
        {
          state: 'comprada',
          stateOrder: newStateOrder,
          paymentMethod,
          paymentStatus,
          subtotal,
          tax,
          // `total` = monto neto adeudado (post-créditos), no el bruto — es
          // lo que efectivamente debe cobrarse (COD hoy, futuras pasarelas).
          total: amountToPay,
        },
        { transaction: t }
      );

      // ── 10. Return checkout summary ────────────────────────────────────────
      return {
        orderId,
        subtotal,
        creditsApplied: creditsUsed,
        amountToPay,
        stateOrder: newStateOrder,
        paymentStatus,
        paymentMethod,
        itemCount: cartItems.length,
      };
    });
  }
}
module.exports = OrderService;
module.exports.MAX_DISPATCH_ATTEMPTS = MAX_DISPATCH_ATTEMPTS;
