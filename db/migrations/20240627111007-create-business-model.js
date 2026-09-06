'use strict';

const { DataTypes, Sequelize } = require('sequelize');
const { BUSINESS_TABLE } = require('../models/businessModel');
const { BUSINESS_OWNER } = require('../models/businessOwnerModel');

// Schema frozen to what "business" looked like at this point in the migration
// history (before 20260613000002 added woo_consumer_key/woo_consumer_secret).
// Do NOT import BusinessSchema live here: it now includes those columns, and
// on a brand-new database that makes this createTable() pre-create them,
// which then makes the later addColumn() migration fail with
// "column already exists".
const BusinessSchemaAtThisPoint = {
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
  name: {
    allowNull: false,
    type: DataTypes.STRING,
  },
  image: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  ownerId: {
    field: 'business_owner_id',
    allowNull: false,
    type: DataTypes.INTEGER,
    references: {
      model: BUSINESS_OWNER,
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable(BUSINESS_TABLE, BusinessSchemaAtThisPoint);
  },
  async down(queryInterface) {
    await queryInterface.dropTable(BUSINESS_TABLE);
  }
};
