'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('business', 'woo_consumer_key', {
      type:         DataTypes.STRING(255),
      allowNull:    true,
      defaultValue: null,
    });
    await queryInterface.addColumn('business', 'woo_consumer_secret', {
      type:         DataTypes.TEXT,
      allowNull:    true,
      defaultValue: null,
    });

    // Seed the first business with env-var credentials so it works immediately after deploy.
    // WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET must be set in Railway before deploying.
    const key    = process.env.WOO_CONSUMER_KEY    || '';
    const secret = process.env.WOO_CONSUMER_SECRET || '';
    if (key && secret) {
      await queryInterface.bulkUpdate(
        'business',
        { woo_consumer_key: key, woo_consumer_secret: secret },
        { id: 8 }
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('business', 'woo_consumer_key');
    await queryInterface.removeColumn('business', 'woo_consumer_secret');
  },
};
