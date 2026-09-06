const express = require('express');

const passport = require('passport');

const { checkRoles, optionalAuth } = require('../middlewares/authHandler');

const OrderService = require('../Services/orderService');
const CustomerService = require('../Services/customerService');
const RecyclerService = require('../Services/recyclerService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getOrderSchema,
  getOrderByUserIdAndOrderId,
  createOrderSchema,
  addItemGuestSchema,
  associateOrderSchema,
  getOrderByState,
  updateOrderSchema,
  updateItemSchema,
  addItemSchema,
  getItemSchema,
  getOrdersByBusinessId,
  getVerifyProductIsInOrderActive,
  checkoutSchema,
} = require('../schemaODtos/orderSchema');
const {
  getOrderIdSchema,
  getOrderAndProofIdSchema,
  uploadProofSchema,
  reviewProofSchema,
} = require('../schemaODtos/paymentProofSchema');
const paymentProofService = require('../Services/paymentProofService');

const router = express.Router();
const service = new OrderService();
const customerService = new CustomerService();
const recyclerService = new RecyclerService();

// --- RUTAS PÚBLICAS (sin autenticación) ---

// GET /api/v1/orders/track/:orderId
// Public order tracking — returns only tracking-safe fields (no PII beyond first name).
// Placed before /:id to avoid Express treating "track" as an id param.
router.get('/track/:orderId', async (req, res, next) => {
  try {
    const orderId = Number(req.params.orderId);
    if (isNaN(orderId)) {
      return res.status(400).json({ message: 'ID de orden inválido.' });
    }

    const order = await service.findOne(orderId);

    if (!order) {
      return res.status(404).json({ message: 'Orden no encontrada.' });
    }

    res.json({
      id:             order.id,
      stateOrder:     order.stateOrder,
      trackingNumber: order.trackingNumber ?? null,
      carrierName:    order.carrierName    ?? null,
      createdAt:      order.createdAt,
      customerName:   order.customer?.name ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// Ruta para que un invitado cree su carrito inicial
router.post(
  '/guest-order',
  async (req, res, next) => {
    try {
      const guestEmail = req.body?.guestEmail || null;
      const newOrder = await service.createGuestOrder(guestEmail);
      res.status(201).json(newOrder);
    } catch (error) {
      next(error);
    }
  }
);

// Ruta para que un invitado agregue productos a su carrito
router.post(
  '/add-item-guest',
  validatorHandler(addItemGuestSchema, 'body'), // Usamos el nuevo schema
  async (req, res, next) => {
    try {
      const body = req.body;
      const newItem = await service.addItemToGuestOrder(body);
      res.status(201).json(newItem);
    } catch (error) {
      next(error);
    }
  }
);

// --- FIN DE RUTAS PÚBLICAS ---

// --- NUEVA RUTA PROTEGIDA (puede ir con las otras rutas PATCH o POST protegidas) ---

// Ruta para asociar la orden de invitado con el usuario que acaba de loguearse/registrarse
router.patch(
  '/associate-order',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'), // Todos los roles pueden reclamar su carrito
  validatorHandler(associateOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const { sub: userId } = req.user;
      const { orderId } = req.body;
      const updatedOrder = await service.associateOrderToCustomer(orderId, userId);
      res.json(updatedOrder);
    } catch (error) {
      next(error);
    }
  }
);

// --- AÑADIR ESTA NUEVA RUTA PÚBLICA (junto a las otras de invitado) ---
router.get(
  '/guest-order/:id',
  validatorHandler(getOrderSchema, 'params'), // Reutilizamos el schema que solo valida el ID
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const order = await service.findGuestOrderById(id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);

// --- Items de carrito (invitado o cliente) — Fase A (A3) ---
// optionalAuth: adjunta req.user si hay JWT; la autorización real (carrito guest
// vs carrito de un cliente + orden en 'carrito') la resuelve el servicio.
router.patch(
  '/item-guest/:id',
  optionalAuth,
  validatorHandler(getItemSchema, 'params'),
  validatorHandler(updateItemSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const updated = await service.updateCartItem(id, req.body, req.user?.sub ?? null);
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/item-guest/:id',
  optionalAuth,
  validatorHandler(getItemSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleted = await service.deleteCartItem(id, req.user?.sub ?? null);
      res.status(200).json(deleted);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /checkout ────────────────────────────────────────────────────────────
// Checks out an existing cart: validates ownership, recalculates totals from
// DB prices, redeems green credits, and advances the order state atomically.
// Any failure (bad stock, bad balance, DB error) rolls back completely.
router.post(
  '/checkout',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(checkoutSchema, 'body'),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const { orderId, creditsToApply } = req.body;
      const summary = await service.checkout(orderId, userId, creditsToApply);
      res.status(200).json(summary);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      const orders = await service.find();
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const order = await service.findOne(id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);
// llamado para obtener todas las ordenes con un estado
router.get(
  '/by/state',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(getOrderByState, 'body'),
  async (req, res, next) => {
    try {
      /*
      const { id } = req.params; */ /*
      const orders = await service.find(); */
      const body = req.body;
      const { state } = body;
      const orders = await service.findOrdersByState(state);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

// Router for get the orders of a business
router.get(
  '/by/business/:businessId',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getOrdersByBusinessId, 'params'),
  async (req, res, next) => {
    try {
      const { businessId } = req.params;

      const orders = await service.findOrdersByBusinessId(businessId);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

//super llamado por user id filtrando estado de orden
router.get(
  '/user/state',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderByState, 'query'),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const body = req.query;
      const { state } = body;
      const order = await service.findOrderByUserIdAndState(userId, state);
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);
//llamado de orden por id validando que coincida con su sub
router.get(
  '/user/order',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderByUserIdAndOrderId, 'body'),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const body = req.body;
      const orderId = body.id;
      const order = await service.findByOrderIdValidatedWidthUserId(
        userId,
        orderId
      );
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/userId/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const orders = await service.findByUser(id);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/verify-product-is-in-order-active/:id/:businessId',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getVerifyProductIsInOrderActive, 'params'),
  async (req, res, next) => {
    try {
      const { id, businessId } = req.params;

      const isVerified = await service.verifyProductIsInOrderActive(
        id,
        businessId
      );
      res.json({
        isVerified,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(createOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = {
        userId: req.user.sub,
        userRole: req.user.role,
      };
      const haveCustomerId = await customerService.findByUserId(body.userId);
      if (body.userRole === 'recycler' && !haveCustomerId) {
        const findRecycler = await recyclerService.findByUserId(body.userId);
        const newCustomer = await customerService.createCustomerByRecycler(
          findRecycler
        );
        return newCustomer;
      }
      const newOrder = await service.create(body);
      res.status(201).json(newOrder);
    } catch (error) {
      next(error);
    }
  }
);

// ── PATCH /orders/:id ────────────────────────────────────────────────────────
// Fase A (A2): SOLO admin / business_owner. Un cliente ya no puede cambiar el
// estado de una orden (antes: cualquier rol podía PATCH {state:'pagada'} sobre
// cualquier orden → despacho sin pago). `state` (legado) ya no se acepta:
// updateOrderSchema lo rechaza. El avance a pago/despacho pasa por checkout(),
// POST /:id/confirm-cod o (Fase C) la aprobación de comprobante.
router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  validatorHandler(updateOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const rta = await service.update(id, body, req.user.role);
      res.status(200).json(rta);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /orders/:id/confirm-cod ─────────────────────────────────────────────
// Fase A (A2): confirma un pedido Contra Entrega. Reemplaza el antiguo
// PATCH /orders/:id {state:'pendiente_envio'} que hacía la tienda sin control.
// El cliente dueño del carrito confirma; el backend revalida stock, persiste
// totales, marca payment_method='cod' / payment_status='pending' (se cobra al
// entregar) y dispara el despacho.
router.post(
  '/:id/confirm-cod',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const result = await service.confirmCod(id, req.user.sub);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── DeUna QR + comprobante — Paso 11 ─────────────────────────────────────────
// Flujo: checkout() ya fijó el total autoritativo → GET .../payment/deuna
// (solo lectura, info del QR/link estático) → POST .../payment-proof (el
// cliente sube evidencia, NUNCA confirma el pago) → GET .../payment-proof
// (dueño o staff revisan lo subido) → POST .../approve o .../reject (SOLO
// admin/business_owner — el cliente no puede aprobarse a sí mismo).

// GET /orders/:id/payment/deuna — info del QR/link DeUna. Solo lectura.
router.get(
  '/:id/payment/deuna',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderIdSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const info = await paymentProofService.getDeunaPaymentInfo(id, req.user.sub, req.user.role);
      res.json(info);
    } catch (error) {
      next(error);
    }
  }
);

// POST /orders/:id/payment-proof — sube un comprobante de pago DeUna.
router.post(
  '/:id/payment-proof',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderIdSchema, 'params'),
  validatorHandler(uploadProofSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const proof = await paymentProofService.uploadProof(id, req.body, req.user.sub, req.user.role);
      res.status(201).json(proof);
    } catch (error) {
      next(error);
    }
  }
);

// GET /orders/:id/payment-proof — lista los comprobantes subidos (dueño o staff).
router.get(
  '/:id/payment-proof',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderIdSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const proofs = await paymentProofService.listProofs(id, req.user.sub, req.user.role);
      res.json(proofs);
    } catch (error) {
      next(error);
    }
  }
);

// POST /orders/:id/payment-proof/:proofId/approve — SOLO admin/business_owner.
// Único camino que confirma el pago y dispara el despacho (vía
// OrderService.confirmPaymentProof → _finalizeAndDispatch, idempotente).
router.post(
  '/:id/payment-proof/:proofId/approve',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getOrderAndProofIdSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id, proofId } = req.params;
      const result = await paymentProofService.approveProof(id, proofId, req.user.sub);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// POST /orders/:id/payment-proof/:proofId/reject — SOLO admin/business_owner.
router.post(
  '/:id/payment-proof/:proofId/reject',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getOrderAndProofIdSchema, 'params'),
  validatorHandler(reviewProofSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id, proofId } = req.params;
      const result = await paymentProofService.rejectProof(id, proofId, req.user.sub, req.body.reason);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── POST /orders/:id/retry-fulfillment ───────────────────────────────────────
// Retries Dropi dispatch for orders stuck in 'error_api_proveedor'.
// Admin / business_owner only.
router.post(
  '/:id/retry-fulfillment',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const result = await service.retryFulfillment(id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ── PATCH /orders/:id/sync-delivery-status ───────────────────────────────────
// Fetches the latest Dropi delivery status and mirrors it locally.
router.patch(
  '/:id/sync-delivery-status',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const result = await service.syncDropiDeliveryStatus(id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleteOrder = await service.delete(id);
      res.status(201).json(deleteOrder);
    } catch (error) {
      next(error);
    }
  }
);

// ITEMS

router.get(
  '/add-item/:id',
  validatorHandler(getItemSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const item = await service.findOneItem(id);
      res.json(item);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/add-item',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(addItemSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newItem = await service.addItem(body);
      res.status(201).json(newItem);
    } catch (error) {
      next(error);
    }
  }
);

// Fase A (A3): antes sin autenticación (auth comentada) → cualquiera podía
// modificar/borrar items de cualquier orden. Ahora pasa por optionalAuth +
// autorización en el servicio (misma regla que /item-guest/:id).
router.patch(
  '/add-item/:id',
  optionalAuth,
  validatorHandler(getItemSchema, 'params'),
  validatorHandler(updateItemSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const updated = await service.updateCartItem(id, req.body, req.user?.sub ?? null);
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/add-item/:id',
  optionalAuth,
  validatorHandler(getItemSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleted = await service.deleteCartItem(id, req.user?.sub ?? null);
      res.status(200).json(deleted);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
