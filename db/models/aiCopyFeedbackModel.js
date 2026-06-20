'use strict';

const { Model, DataTypes } = require('sequelize');

const AI_COPY_FEEDBACK_TABLE = 'ai_copy_feedback';

const AiCopyFeedbackSchema = {
  id: {
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
    type: DataTypes.INTEGER,
  },
  // Set after product creation — nullable because neuro-copy runs before the product exists.
  productId: {
    field: 'product_id',
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // Stored for fuzzy matching at generation time (no productId yet).
  productName: {
    field: 'product_name',
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  // Stored for category-level style inheritance (secondary fallback).
  categoryId: {
    field: 'category_id',
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // The final text the owner approved/edited — this is the style reference.
  approvedText: {
    field: 'approved_text',
    type: DataTypes.TEXT,
    allowNull: false,
  },
  createdAt: {
    field: 'created_at',
    allowNull: false,
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
};

class AiCopyFeedback extends Model {
  static associate() {}

  static config(sequelize) {
    return {
      sequelize,
      tableName: AI_COPY_FEEDBACK_TABLE,
      modelName: 'AiCopyFeedback',
      timestamps: false,
    };
  }
}

module.exports = { AI_COPY_FEEDBACK_TABLE, AiCopyFeedback, AiCopyFeedbackSchema };
