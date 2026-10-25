'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');

// Cotizaciones de Smart Shipping (migración 20261025000001-smart-shipping).
// Uso único (used_at), vigencia (expires_at), ligadas a orden, usuario, ciudad y huella del carrito.
const SHIPPING_QUOTE_TABLE = 'shipping_quotes';

const ShippingQuoteSchema = {
  id:            { allowNull: false, primaryKey: true, type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4 },
  orderId:       { field: 'order_id', allowNull: false, type: DataTypes.INTEGER },
  userId:        { field: 'user_id', allowNull: false, type: DataTypes.INTEGER },
  cityKey:       { field: 'city_key', allowNull: false, type: DataTypes.STRING(120) },
  dropiCityId:   { field: 'dropi_city_id', allowNull: false, type: DataTypes.INTEGER },
  paymentMethod: { field: 'payment_method', allowNull: false, type: DataTypes.STRING(12) },
  cartHash:      { field: 'cart_hash', allowNull: false, type: DataTypes.STRING(64) },
  options:       { allowNull: false, type: DataTypes.JSONB },
  source:        { allowNull: false, type: DataTypes.STRING(20) },
  ratesAsOf:     { field: 'rates_as_of', allowNull: true, type: DataTypes.STRING(40) },
  expiresAt:     { field: 'expires_at', allowNull: false, type: DataTypes.DATE },
  usedAt:        { field: 'used_at', allowNull: true, type: DataTypes.DATE },
  createdAt:     { field: 'created_at', allowNull: false, type: DataTypes.DATE, defaultValue: Sequelize.NOW },
};

class ShippingQuote extends Model {
  static associate() {}

  static config(sequelize) {
    return { sequelize, tableName: SHIPPING_QUOTE_TABLE, modelName: 'ShippingQuote', timestamps: false };
  }
}

module.exports = { ShippingQuote, ShippingQuoteSchema, SHIPPING_QUOTE_TABLE };
