'use strict';

const SALES_PERFORMANCE_TABLE = 'sales_performance';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(SALES_PERFORMANCE_TABLE, {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      session_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      outcome: {
        // cart_add | checkout_redirect | support_query | no_action
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      product_ids: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: null,
      },
      cart_value: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: null,
      },
      turns: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      last_intent: {
        type: Sequelize.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      tool_calls: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: null,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex(SALES_PERFORMANCE_TABLE, ['session_id'], {
      name: 'idx_sales_perf_session_id',
    });
    await queryInterface.addIndex(SALES_PERFORMANCE_TABLE, ['created_at'], {
      name: 'idx_sales_perf_created_at',
    });
    await queryInterface.addIndex(SALES_PERFORMANCE_TABLE, ['outcome'], {
      name: 'idx_sales_perf_outcome',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(SALES_PERFORMANCE_TABLE);
  },
};
