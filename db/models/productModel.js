const { Model, DataTypes, Sequelize } = require('sequelize');

const { CATEGORY_TABLE } = require('./categoryModel');
const { BUSINESS_TABLE } = require('./businessModel');

const PRODUCT_TABLE = 'products';

const ProductSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  price: {
    type: DataTypes.FLOAT,
    allowNull: false,
  },
  isDeleted: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_deleted',
  },
  stock: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  showShop: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'show_shop',
  },
  createdAt: {
    allowNull: false,
    type: DataTypes.DATE,
    field: 'created_at',
    defaultValue: Sequelize.NOW,
  },
  categoryId: {
    field: 'category_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: CATEGORY_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  businessId: {
    field: 'business_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: {
      model: BUSINESS_TABLE,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },

  // ── Dropshipping sync fields (Phase 2) ────────────────────────────
  externalId: {
    field: 'external_id',
    allowNull: true,
    type: DataTypes.STRING,
  },
  sourceProvider: {
    field: 'source_provider',
    allowNull: true,
    type: DataTypes.STRING,
  },
  lastSyncAt: {
    field: 'last_sync_at',
    allowNull: true,
    type: DataTypes.DATE,
  },
  // JSON array of image URLs — first element mirrors the `image` field.
  // Stored as TEXT to avoid needing a separate JSONB column on older PG versions.
  images: {
    allowNull: true,
    type: DataTypes.TEXT,
  },
  // JSON array of variant groups: [{option, values:[{label,image,stock}]}]
  variants: {
    allowNull: true,
    type: DataTypes.TEXT,
  },
  dropiProductId: {
    field: 'dropi_product_id',
    allowNull: true,
    type: DataTypes.STRING,
  },
  // Free-form product metadata — stored natively as JSONB in PostgreSQL.
  // Example: { "Color": "Azul", "Talla": "XL" }
  attributes: {
    field: 'attributes',
    allowNull: true,
    type: DataTypes.JSONB,
  },
  // Bundle/variant items: shared JSONB field for both modes.
  // Bundle   (isBundle=true):  [{ id, qty }]           — all items dispatched together.
  // Variants (isBundle=false): [{ id, value, name? }]  — user selects one; selected_dropi_id on OrderProduct drives dispatch.
  dropiItems: {
    field: 'dropi_items',
    allowNull: true,
    type: DataTypes.JSONB,
  },
  // When true → all dropiItems dispatched as a pack.
  // When false/null → dropiItems are selectable variants; dispatch uses OrderProduct.selectedDropiId.
  isBundle: {
    field: 'is_bundle',
    allowNull: true,
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // Supplier/Dropi cost price — stored at import time to compute margin without re-fetching Dropi.
  costPrice: {
    field: 'cost_price',
    allowNull: true,
    type: DataTypes.FLOAT,
  },
};

class Product extends Model {
  static associate(models) {
    this.belongsTo(models.Category, { as: 'category' });
    this.belongsTo(models.Business, { as: 'business' });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: PRODUCT_TABLE,
      modelName: 'Product',
      timestamps: false,
    };
  }
}

module.exports = { Product, ProductSchema, PRODUCT_TABLE };
