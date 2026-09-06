const { Model, DataTypes, Sequelize } = require('sequelize');

const { ORDER_TABLE } = require('./orderModel');
const { PRODUCT_TABLE } = require('./productModel');

const ORDER_PRODUCT_TABLE = 'orders_products';

const OrderProductSchema =  {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  amount: {
    allowNull: false,
    type: DataTypes.INTEGER
  },
  orderId: {
    field: 'order_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: {
      model: ORDER_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  productId: {
    field: 'product_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: {
      model: PRODUCT_TABLE,
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  // Dropi variant ID chosen by the customer at add-to-cart time.
  // Only set for variant products (isBundle=false, dropiItems.length > 1).
  // Used by dispatchToProviders to send the correct variant to Dropi.
  selectedDropiId: {
    field: 'selected_dropi_id',
    allowNull: true,
    type: DataTypes.STRING(64),
    defaultValue: null,
  },
  // Pricing Engine (docs/PRICING_ENGINE_SPEC.md, sección C) — snapshot
  // histórico e inmutable. NULL = no capturado / desconocido en ese momento,
  // NUNCA 0. No se escribe ni se lee en ningún flujo todavía (Paso 1 solo
  // declara el campo; el wiring de checkout es un paso posterior).
  unitPriceGross: {
    field: 'unit_price_gross',
    allowNull: true,
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: null,
  },
  unitCostSnapshot: {
    field: 'unit_cost_snapshot',
    allowNull: true,
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: null,
  },
}

class OrderProduct extends Model {

  static associate(models) {
    //
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: ORDER_PRODUCT_TABLE,
      modelName: 'OrderProduct',
      timestamps: false
    }
  }
}

module.exports = { OrderProduct, OrderProductSchema, ORDER_PRODUCT_TABLE };
