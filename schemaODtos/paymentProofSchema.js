'use strict';

const Joi = require('joi');

const orderId = Joi.number().integer();
const proofId = Joi.number().integer();

const getOrderIdSchema = Joi.object({
  id: orderId.required(),
});

const getOrderAndProofIdSchema = Joi.object({
  id: orderId.required(),
  proofId: proofId.required(),
});

// fileUrl: URL ya subida por el cliente a Firebase Storage (mismo patrón que
// product.image — el backend nunca recibe bytes de archivo, solo la
// referencia). Este schema solo valida FORMA (https, longitud). Las reglas de
// NEGOCIO (dominio de storage confiable, carpeta esperada, extensión de
// imagen, existencia real del archivo) viven exclusivamente en
// Services/paymentProofImageValidation.js — no se duplican aquí.
// Sin campo de monto/total — el cliente NUNCA puede influir el monto autorizado.
const uploadProofSchema = Joi.object({
  fileUrl: Joi.string().uri({ scheme: ['https'] }).max(2048).required(),
});

const reviewProofSchema = Joi.object({
  reason: Joi.string().allow('', null).max(500),
});

module.exports = {
  getOrderIdSchema,
  getOrderAndProofIdSchema,
  uploadProofSchema,
  reviewProofSchema,
};
