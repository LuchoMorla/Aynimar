'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('products', 'cost_price', {
      type:         Sequelize.FLOAT,
      allowNull:    true,
      defaultValue: null,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('products', 'cost_price');
  },
};
