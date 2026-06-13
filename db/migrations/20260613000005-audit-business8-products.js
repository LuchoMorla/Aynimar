'use strict';

module.exports = {
  async up(queryInterface) {
    // Full breakdown of ALL products in business 8, grouped by source_provider
    const [bySource] = await queryInterface.sequelize.query(`
      SELECT
        COALESCE(source_provider, 'NULL/manual') AS source_provider,
        COUNT(*)                                  AS total,
        COUNT(*) FILTER (WHERE is_deleted = true) AS deleted
      FROM products
      WHERE business_id = 8
      GROUP BY source_provider
      ORDER BY total DESC
    `);

    console.log('[audit] Products in business_id=8 by source_provider:');
    console.log(JSON.stringify(bySource, null, 2));

    const [[{ grand_total }]] = await queryInterface.sequelize.query(`
      SELECT COUNT(*) AS grand_total FROM products WHERE business_id = 8
    `);
    console.log(`[audit] Grand total (all sources, including deleted): ${grand_total}`);

    // Also check if there are products with no business_id that appear (shouldn't, but verify)
    const [[{ orphan }]] = await queryInterface.sequelize.query(`
      SELECT COUNT(*) AS orphan FROM products WHERE business_id IS NULL
    `);
    console.log(`[audit] Orphan products (business_id IS NULL): ${orphan}`);
  },

  async down() {},
};
