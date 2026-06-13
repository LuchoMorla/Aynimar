'use strict';

module.exports = {
  async up(queryInterface) {
    const [[{ total }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS total FROM products
       WHERE business_id = 8 AND source_provider = 'dropi'`
    );

    console.log(`[cleanup] Found ${total} Dropi products for business_id=8.`);

    if (parseInt(total, 10) === 0) {
      console.log('[cleanup] Nothing to delete.');
      return;
    }

    await queryInterface.sequelize.query(
      `DELETE FROM products
       WHERE business_id = 8 AND source_provider = 'dropi'`
    );

    const [[{ remaining }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS remaining FROM products
       WHERE business_id = 8 AND source_provider = 'dropi'`
    );

    console.log(`[cleanup] Deleted ${total} rows. Remaining Dropi/business8 rows: ${remaining}.`);
  },

  async down() {
    // Irreversible — deleted product data cannot be recovered from a migration.
  },
};
