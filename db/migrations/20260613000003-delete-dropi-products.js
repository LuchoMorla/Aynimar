'use strict';

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS total FROM products WHERE source_provider = 'dropi'"
    );
    const total = parseInt(rows[0].total, 10);
    console.log(`[cleanup] Deleting ${total} Dropi products from local DB...`);

    await queryInterface.sequelize.query(
      "DELETE FROM products WHERE source_provider = 'dropi'"
    );

    console.log(`[cleanup] Done. ${total} Dropi products removed.`);
  },

  async down() {
    // Intentionally irreversible — deleted rows cannot be recovered from a migration.
  },
};
