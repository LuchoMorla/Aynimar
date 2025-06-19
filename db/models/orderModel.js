/* const { Model, DataTypes, Sequelize } = require('sequelize');
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
    allowNull: false,
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
      "controversia_escalada",
      "controversia_resuelta",
      'por_devolver',
      'devuelto'
    ),
    defaultValue: 'comprado_pendiente_pago',
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
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
 */
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
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: CUSTOMER_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  paymentMethod: {
    field: 'payment_method',
    allowNull: false,
    type: DataTypes.STRING,
    defaultValue: 'contra_entrega',
  },
  status: {
    allowNull: false,
    type: DataTypes.STRING,
    defaultValue: 'pendiente',
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
      'devuelto'
    ),
    defaultValue: 'comprado_pendiente_pago',
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  /* total: {
    type: DataTypes.VIRTUAL,
    get() {
      if (this.items && this.items.length > 0) {
        return this.items.reduce((total, item) => {
          return total + item.price * item.OrderProduct.amount;
        }, 0);
      }
      return 0;
    },
  }, */

  total: {
    type: DataTypes.VIRTUAL,
    get() {
      if (!this.items) {
        console.warn('Advertencia: el campo virtual `total` no puede calcularse porque no se incluyó la relación `items`');
        return 0;
      }
      if (this.items.length > 0) {
        return this.items.reduce((total, item) => {
          const cantidad = item.OrderProduct?.amount || 0;
          const precio = item.price || 0;
          return total + precio * cantidad;
        }, 0);
      }
      return 0;
    },
  },

};

class Order extends Model {
  static associate(models) {
    this.belongsTo(models.Customer, { as: 'customer' });
    this.belongsToMany(models.Product, {
      as: 'items',
      through: models.OrderProduct,
      foreignKey: 'orderId',
      otherKey: 'productId',
      onDelete: 'CASCADE',
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