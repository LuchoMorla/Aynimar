const Joi = require('joi');
const {
  ORDER_STATE_ORDER_VALUES,
  ORDER_PAYMENT_STATUS_VALUES,
} = require('../db/models/orderModel');

const id = Joi.number().integer();
const customerId = Joi.number().integer();
const orderId = Joi.number().integer();
const productId = Joi.number().integer();
const amount = Joi.number().integer().min(1);
// `state` sigue permisivo para las consultas por estado (?state=carrito, etc.);
// para ESCRITURA se usa el enum cerrado en updateOrderSchema.
const state = Joi.string();
// Fase A (A2): enums cerrados — antes cualquier string entraba.
const stateOrder = Joi.string().valid(...ORDER_STATE_ORDER_VALUES);
const paymentStatus = Joi.string().valid(...ORDER_PAYMENT_STATUS_VALUES);
const paymentMethod = Joi.string();

const getOrderSchema = Joi.object({
  id: id.required(),
});

const getVerifyProductIsInOrderActive = Joi.object({
  id: productId.required(),
  businessId: id.required(),
});

const getOrderByState = Joi.object({
  state: state.required(),
});
/* me parece que es su id es el orderID que hay que enviarle */
const getOrderByUserIdAndOrderId = Joi.object({
  id: id.required(),
});
/* No estoy tran seguro de decar el create order sin el required */
const createOrderSchema = Joi.object({
  customerId: customerId,
});

// --- ESQUEMA para asociar la orden ---
const associateOrderSchema = Joi.object({
  orderId: orderId.required(),
});

// --- ESQUEMA para agregar item como invitado ---
const addItemGuestSchema = Joi.object({
  orderId: orderId.required(),
  productId: productId.required(),
  amount: amount.required(),
  guestEmail: Joi.string().email().optional(),
  selectedDropiId: Joi.string().allow(null, '').optional(),
});

// Fase A (A2): PATCH /orders/:id — sólo admin/business_owner (ver ruta).
// `state` (string legado) YA NO se acepta por esta vía: cualquier request con
// `state` es rechazada por Joi (unknown key). El avance a 'paid' / despacho pasa
// por checkout(), confirmCod() o (Fase C) la aprobación de comprobante.
const updateOrderSchema = Joi.object({
  customerId: customerId,
  stateOrder: stateOrder,          // enum cerrado
  paymentStatus: paymentStatus,    // enum cerrado
  paymentMethod: paymentMethod,
});

//ITEMS
const addItemSchema = Joi.object({
  orderId: orderId.required(),
  productId: productId.required(),
  amount: amount.required(),
  selectedDropiId: Joi.string().allow(null, '').optional(),
});

const getItemSchema = Joi.object({
  id: id.required(),
});

const getOrdersByBusinessId = Joi.object({
  businessId: id.required(),
});

const updateItemSchema = Joi.object({
  orderId: orderId,
  productId: productId,
  amount: amount,
});
//se le podrían agregar cosas como estados(entregada, se pago, no se pago, etc.), dirección, etc.

const checkoutSchema = Joi.object({
  orderId: orderId.required(),
  // Integer credits the user wants to redeem (0 = no credits, omit = same).
  // The service caps this at floor(subtotal) automatically.
  creditsToApply: Joi.number().integer().min(0).default(0),
});

module.exports = {
  getOrderSchema,
  getOrderByUserIdAndOrderId,
  getOrderByState,
  createOrderSchema,
  associateOrderSchema,
  addItemGuestSchema,
  updateOrderSchema,
  addItemSchema,
  updateItemSchema,
  getItemSchema,
  getOrdersByBusinessId,
  getVerifyProductIsInOrderActive,
  checkoutSchema,
};
