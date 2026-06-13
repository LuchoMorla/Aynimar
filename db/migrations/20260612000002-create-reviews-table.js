'use strict';

const { REVIEW_TABLE } = require('../models/reviewModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(REVIEW_TABLE, {
      id: {
        allowNull:     false,
        autoIncrement: true,
        primaryKey:    true,
        type:          Sequelize.INTEGER,
      },
      product_id: {
        allowNull:  false,
        type:       Sequelize.INTEGER,
        references: { model: 'products', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      business_id: {
        allowNull:  true,
        type:       Sequelize.INTEGER,
        references: { model: 'businesses', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      },
      rating: {
        allowNull: false,
        type:      Sequelize.INTEGER,
      },
      customer_name: {
        allowNull: false,
        type:      Sequelize.STRING,
      },
      city: {
        allowNull: true,
        type:      Sequelize.STRING,
      },
      comment: {
        allowNull: false,
        type:      Sequelize.TEXT,
      },
      images_json: {
        allowNull: true,
        type:      Sequelize.TEXT,
      },
      created_at: {
        allowNull:    false,
        type:         Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex(REVIEW_TABLE, ['product_id'], { name: 'reviews_product_id_idx' });
    await queryInterface.addIndex(REVIEW_TABLE, ['business_id'], { name: 'reviews_business_id_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(REVIEW_TABLE);
  },
};
