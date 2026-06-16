'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders_products', 'selected_dropi_id', {
      type: Sequelize.STRING(64),
      allowNull: true,
      defaultValue: null,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('orders_products', 'selected_dropi_id');
  },
};
