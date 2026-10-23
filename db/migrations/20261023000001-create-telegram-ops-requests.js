'use strict';

/**
 * Encargos del dueño al CTO/CEO desde el bot de Telegram (botón «💬 Pedir al CTO / CEO»).
 * Mismo diseño que Pescafast (telegram_ops_requests). Los lee y responde el script local
 * ops-ceo-cto/tools/encargos-aynimar.sh directo en la BD; no hay API ni variable nueva.
 *   request_id  único por mensaje de Telegram (tg-<chat>-<message_id>): un reintento
 *               del webhook no duplica el encargo.
 *
 * ADITIVA: una tabla nueva, sin FK. down → DROP TABLE (se pierden encargos y respuestas).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS telegram_ops_requests (
      id          SERIAL PRIMARY KEY,
      request_id  VARCHAR(64) NOT NULL UNIQUE,
      recipient   VARCHAR(8)  NOT NULL CHECK (recipient IN ('cto','ceo')),
      body        TEXT        NOT NULL,
      status      VARCHAR(12) NOT NULL DEFAULT 'nueva' CHECK (status IN ('nueva','en_curso','respondida')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      taken_at    TIMESTAMPTZ NULL,
      answered_at TIMESTAMPTZ NULL,
      answer      TEXT NULL
    )`);
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS telegram_ops_requests_status_idx ON telegram_ops_requests (status, id)');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS telegram_ops_requests');
  },
};
