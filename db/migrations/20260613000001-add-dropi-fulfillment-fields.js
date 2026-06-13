'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Dropi order ID returned on successful dispatch
    await queryInterface.addColumn('orders', 'dropi_order_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
      defaultValue: null,
    });
    // 'DISPATCHED' | 'PENDING_DROPI_FULFILLMENT' | null
    await queryInterface.addColumn('orders', 'fulfillment_status', {
      type: Sequelize.STRING(50),
      allowNull: true,
      defaultValue: null,
    });
    // Error message saved when Dropi dispatch fails — shown in dashboard retry UI
    await queryInterface.addColumn('orders', 'fulfillment_error', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
    });
    // Dropi delivery status synced from their API ('Generada', 'En transporte', 'Entregado', etc.)
    await queryInterface.addColumn('orders', 'delivery_status', {
      type: Sequelize.STRING(100),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('orders', 'dropi_order_id');
    await queryInterface.removeColumn('orders', 'fulfillment_status');
    await queryInterface.removeColumn('orders', 'fulfillment_error');
    await queryInterface.removeColumn('orders', 'delivery_status');
  },
};
