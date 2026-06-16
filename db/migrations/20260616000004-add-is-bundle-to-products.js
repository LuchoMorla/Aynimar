'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('products', 'is_bundle', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('products', 'is_bundle');
  },
};
