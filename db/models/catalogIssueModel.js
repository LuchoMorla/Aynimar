'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');

const CATALOG_ISSUE_TABLE = 'catalog_issues';

const CatalogIssueSchema = {
  id:             { primaryKey: true, autoIncrement: true, allowNull: false, type: DataTypes.INTEGER },
  productId:      { field: 'product_id', allowNull: false, type: DataTypes.INTEGER },
  type:           { allowNull: false, type: DataTypes.STRING(40) },
  severity:       { allowNull: false, type: DataTypes.STRING(10) },
  title:          { allowNull: false, type: DataTypes.TEXT },
  details:        { allowNull: false, type: DataTypes.JSONB, defaultValue: {} },
  suggestions:    { allowNull: false, type: DataTypes.JSONB, defaultValue: [] },
  source:         { allowNull: false, type: DataTypes.STRING(10) },
  fingerprint:    { type: DataTypes.TEXT },
  status:         { allowNull: false, type: DataTypes.STRING(12), defaultValue: 'open' },
  decisionAction: { field: 'decision_action', type: DataTypes.STRING(20) },
  decisionParams: { field: 'decision_params', type: DataTypes.JSONB },
  decisionNote:   { field: 'decision_note', type: DataTypes.TEXT },
  decidedBy:      { field: 'decided_by', type: DataTypes.INTEGER },
  decidedAt:      { field: 'decided_at', type: DataTypes.DATE },
  resolvedAt:     { field: 'resolved_at', type: DataTypes.DATE },
  createdAt:      { field: 'created_at', allowNull: false, type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  updatedAt:      { field: 'updated_at', allowNull: false, type: DataTypes.DATE, defaultValue: Sequelize.NOW },
};

class CatalogIssue extends Model {
  static associate(models) {
    this.belongsTo(models.Product, { as: 'product', foreignKey: 'productId' });
  }

  static config(sequelize) {
    return { sequelize, tableName: CATALOG_ISSUE_TABLE, modelName: 'CatalogIssue', timestamps: true };
  }
}

module.exports = { CatalogIssue, CatalogIssueSchema, CATALOG_ISSUE_TABLE };
