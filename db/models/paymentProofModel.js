'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');
const { ORDER_TABLE } = require('./orderModel');
const { USER_TABLE } = require('./userModel');

const PAYMENT_PROOF_TABLE = 'payment_proofs';

// Estado de REVISIÓN del comprobante — distinto del payment_status de la
// orden (que sigue siendo la única fuente de verdad de si el pago está
// confirmado). Subir un comprobante nunca crea uno en 'approved' — siempre
// nace 'pending', y solo un admin/business_owner puede moverlo.
const PAYMENT_PROOF_STATUS_VALUES = ['pending', 'approved', 'rejected'];

const PaymentProofSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  orderId: {
    field: 'order_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: ORDER_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },
  // Referencia SEGURA al archivo (URL ya subida por el cliente a
  // almacenamiento externo — mismo patrón que product.image). El backend
  // nunca recibe ni almacena bytes de archivo.
  fileUrl: {
    field: 'file_url',
    allowNull: false,
    type: DataTypes.TEXT,
  },
  uploadedByUserId: {
    field: 'uploaded_by_user_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: { model: USER_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  status: {
    allowNull: false,
    type: DataTypes.ENUM(...PAYMENT_PROOF_STATUS_VALUES),
    defaultValue: 'pending',
  },
  reviewedByUserId: {
    field: 'reviewed_by_user_id',
    allowNull: true,
    type: DataTypes.INTEGER,
    references: { model: USER_TABLE, key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  reviewedAt: {
    field: 'reviewed_at',
    allowNull: true,
    type: DataTypes.DATE,
    defaultValue: null,
  },
  reviewNote: {
    field: 'review_note',
    allowNull: true,
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  createdAt: {
    field: 'created_at',
    allowNull: false,
    type: DataTypes.DATE,
    defaultValue: Sequelize.NOW,
  },
};

class PaymentProof extends Model {
  static associate(models) {
    this.belongsTo(models.Order, { as: 'order', foreignKey: 'orderId' });
    this.belongsTo(models.User, { as: 'uploadedBy', foreignKey: 'uploadedByUserId' });
    this.belongsTo(models.User, { as: 'reviewedBy', foreignKey: 'reviewedByUserId' });
  }

  static config(sequelize) {
    return {
      sequelize,
      tableName: PAYMENT_PROOF_TABLE,
      modelName: 'PaymentProof',
      timestamps: false,
    };
  }
}

module.exports = {
  PAYMENT_PROOF_TABLE,
  PAYMENT_PROOF_STATUS_VALUES,
  PaymentProofSchema,
  PaymentProof,
};
