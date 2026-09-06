'use strict';

/**
 * Fase A — A1: `payment_status` como fuente de verdad del estado de pago.
 *
 * Hasta ahora el "pago" se infería mezclando `orders.state` (string libre) y
 * `orders.state_order` (ENUM de fulfillment). Este campo separa el estado del
 * PAGO del estado de la ORDEN / envío.
 *
 * Valores:
 *   pending              — orden creada, sin pago confirmado (incluye COD: se
 *                          cobra al entregar)
 *   pending_verification — el cliente declaró haber pagado y subió comprobante
 *                          (transferencia / Deuna) — espera revisión de un admin
 *   paid                 — pago confirmado por el backend (créditos, o comprobante
 *                          aprobado, o pasarela verificada en el futuro)
 *   failed               — pago rechazado / comprobante rechazado
 *   refunded             — reembolsado
 *
 * BACKFILL (revisado en Fase B, decisión 3):
 *   - `paid` SÓLO con evidencia real de pago:
 *       · flujo histórico de tarjeta      → `state = 'pagada'`
 *       · créditos que cubrieron el 100%  → `state = 'comprada'` + `green_credits`
 *   - COD histórico (`state = 'pendiente_envio'`) queda `pending` (se cobra en
 *     la entrega; consistente con el nuevo confirm-cod). NO se marca `paid`
 *     sólo por el estado.
 *   - Segundo UPDATE (opcional, revisar): normaliza `payment_method='cod'` en
 *     el COD histórico para que dashboard/reportes lo filtren igual que las
 *     órdenes nuevas. No toca `payment_status` ni datos financieros.
 *
 * PostgreSQL no permite eliminar valores de un ENUM: el down() sólo quita la
 * columna.
 */

const {
  ORDER_TABLE,
  ORDER_PAYMENT_STATUS_VALUES: PAYMENT_STATUS_VALUES,
} = require('../models/orderModel');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(ORDER_TABLE, 'payment_status', {
      type: Sequelize.DataTypes.ENUM(...PAYMENT_STATUS_VALUES),
      allowNull: false,
      defaultValue: 'pending',
    });

    // ── 1. `paid` SÓLO con evidencia de pago real ──────────────────────────
    await queryInterface.sequelize.query(`
      UPDATE "${ORDER_TABLE}"
         SET "payment_status" = 'paid'
       WHERE "state" = 'pagada'
          OR ("state" = 'comprada' AND "payment_method" = 'green_credits')
    `);

    // ── 2. Identificar COD histórico — NO cambia payment_status ────────────
    // (revisar antes de aplicar; se puede omitir sin afectar el código nuevo)
    await queryInterface.sequelize.query(`
      UPDATE "${ORDER_TABLE}"
         SET "payment_method" = 'cod'
       WHERE "state" = 'pendiente_envio'
         AND ("payment_method" IS NULL OR "payment_method" = 'contra_entrega')
    `);
  },

  async down(queryInterface) {
    // Nota: down() NO revierte la normalización payment_method='cod' del UPDATE #2
    // (no se puede reconstruir el valor original NULL vs 'contra_entrega'; es
    // cosmético). El efecto del UPDATE #1 desaparece al quitar la columna.
    await queryInterface.removeColumn(ORDER_TABLE, 'payment_status');
    await queryInterface.sequelize
      .query('DROP TYPE IF EXISTS "enum_orders_payment_status";')
      .catch(() => {
        /* el tipo puede seguir referenciado — no es fatal para el rollback */
      });
  },
};
