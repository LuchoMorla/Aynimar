'use strict';

const AI_COPY_FEEDBACK_TABLE = 'ai_copy_feedback';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(AI_COPY_FEEDBACK_TABLE, {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      product_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
      },
      product_name: {
        type: Sequelize.STRING(255),
        allowNull: true,
        defaultValue: null,
      },
      category_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
      },
      approved_text: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex(AI_COPY_FEEDBACK_TABLE, ['product_id'], {
      name: 'idx_ai_copy_feedback_product_id',
    });
    await queryInterface.addIndex(AI_COPY_FEEDBACK_TABLE, ['product_name'], {
      name: 'idx_ai_copy_feedback_product_name',
    });
    await queryInterface.addIndex(AI_COPY_FEEDBACK_TABLE, ['category_id'], {
      name: 'idx_ai_copy_feedback_category_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(AI_COPY_FEEDBACK_TABLE);
  },
};
