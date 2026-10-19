'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');

const CREATIVE_REVIEW_TABLE = 'creative_reviews';
const CREATIVE_REVIEW_STATUS = ['pending', 'approved', 'rejected', 'changes_requested'];

const CreativeReviewSchema = {
  ref:               { primaryKey: true, allowNull: false, type: DataTypes.STRING(32) },
  productId:         { field: 'product_id', type: DataTypes.INTEGER },
  variant:           { type: DataTypes.STRING(8) },
  network:           { type: DataTypes.STRING(20) },
  utmLink:           { field: 'utm_link', type: DataTypes.TEXT },
  caption:           { type: DataTypes.TEXT },
  telegramFileId:    { field: 'telegram_file_id', type: DataTypes.TEXT },
  telegramMessageId: { field: 'telegram_message_id', type: DataTypes.BIGINT },
  status:            { allowNull: false, type: DataTypes.STRING(20), defaultValue: 'pending', validate: { isIn: [CREATIVE_REVIEW_STATUS] } },
  changeRequest:     { field: 'change_request', type: DataTypes.TEXT },
  decidedAt:         { field: 'decided_at', type: DataTypes.DATE },
  decidedBy:         { field: 'decided_by', type: DataTypes.BIGINT },
  createdAt:         { field: 'created_at', allowNull: false, type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  updatedAt:         { field: 'updated_at', allowNull: false, type: DataTypes.DATE, defaultValue: Sequelize.NOW },
};

class CreativeReview extends Model {
  static associate() {}

  static config(sequelize) {
    return { sequelize, tableName: CREATIVE_REVIEW_TABLE, modelName: 'CreativeReview', timestamps: true };
  }
}

module.exports = { CreativeReview, CreativeReviewSchema, CREATIVE_REVIEW_TABLE, CREATIVE_REVIEW_STATUS };
