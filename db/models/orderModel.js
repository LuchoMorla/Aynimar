const { Model, DataTypes, Sequelize } = require('sequelize');
const { CUSTOMER_TABLE } = require('./customerModel');

const ORDER_TABLE = 'orders';

const OrderSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  customerId: {
    field: 'customer_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: {
      model: CUSTOMER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  state: {
    field: 'state',
    allowNull: true,
    type: DataTypes.STRING,
    defaultValue: 'carrito',
  },
  stateOrder: {
    field: 'state_order',
    allowNull: false,
    type: DataTypes.ENUM(
      'comprado_pendiente_pago',
      'comprado_pendiente_negocio',
      'aprobado',
      'en_preparacion',
      'necesita_edicion',
      'enviado',
      'entregado',
      'cancelado',
      'en_controversia',
      'controversia_escalada',
      'controversia_resuelta',
      'por_devolver',
      'devuelto',
      'error_api_proveedor',
      'en_transito'
    ),
    defaultValue: 'comprado_pendiente_pago',
  },
  trackingNumber: {
    field:        'tracking_number',
    allowNull:    true,
    type:         DataTypes.STRING(255),
  },
  carrierName: {
    field:        'carrier_name',
    allowNull:    true,
    type:         DataTypes.STRING(100),
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  paymentMethod: {
    field: 'payment_method',
    allowNull: true,
    type: DataTypes.STRING,
  },
  // ── Dropi fulfillment tracking ───────────────────────────────────────────────
  dropiOrderId: {
    field:     'dropi_order_id',
    allowNull: true,
    type:      DataTypes.STRING(100),
  },
  // 'DISPATCHED' | 'PENDING_DROPI_FULFILLMENT' | null
  fulfillmentStatus: {
    field:     'fulfillment_status',
    allowNull: true,
    type:      DataTypes.STRING(50),
  },
  fulfillmentError: {
    field:     'fulfillment_error',
    allowNull: true,
    type:      DataTypes.TEXT,
  },
  // Dropi delivery status synced from their API
  deliveryStatus: {
    field:     'delivery_status',
    allowNull: true,
    type:      DataTypes.STRING(100),
  },
  // Number of automated retry attempts by dropiRetryWorker (max 3 before FAILED_DROPI_FULFILLMENT)
  fulfillmentRetryCount: {
    field:        'fulfillment_retry_count',
    allowNull:    false,
    type:         DataTypes.INTEGER,
    defaultValue: 0,
  },
  total: {
    type: DataTypes.VIRTUAL,
    get() {
      //Reviso si tenemos productos para que sea el default value
      if (this.items) {
        console.log('existen items en la orden');
        if (this.items.length > 0) {
          return this.items.reduce((total, item) => {
            return total + item.price * item.OrderProduct.amount;
          }, 0);
        }
        return 0;
      }
    },
  },
};

class Order extends Model {
  static associate(models) {
    this.belongsTo(models.Customer, {
      as: 'customer',
    });
    this.belongsToMany(models.Product, {
      as: 'items',
      through: models.OrderProduct,
      foreignKey: 'orderId',
      onDelete: 'CASCADE',
      otherKey: 'productId',
    });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: ORDER_TABLE,
      modelName: 'Order',
      timestamps: false,
    };
  }
}

module.exports = { Order, OrderSchema, ORDER_TABLE };
