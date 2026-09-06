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
 * PostgreSQL no permite eliminar valores de un ENUM, por eso el down() sólo
 * puede quitar la columna, no el tipo. Documentado abajo.
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

    // ── Backfill conservador ────────────────────────────────────────────────
    // Sólo marcamos 'paid' lo que con certeza ya estaba pagado/confirmado:
    //   - órdenes que el flujo anterior movió a 'pagada' o 'pendiente_envio'
    //   - órdenes cubiertas 100% con créditos verdes (checkout con amountToPay=0)
    // Todo lo demás queda en 'pending' (default), incluidas las órdenes en
    // 'carrito' y las que quedaron a medias.
    await queryInterface.sequelize.query(`
      UPDATE "${ORDER_TABLE}"
         SET "payment_status" = 'paid'
       WHERE "state" IN ('pagada', 'pendiente_envio')
          OR ("state" = 'comprada' AND "payment_method" = 'green_credits')
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn(ORDER_TABLE, 'payment_status');
    // El tipo ENUM "enum_orders_payment_status" queda huérfano. Para eliminarlo
    // manualmente (sólo si ninguna columna lo usa):
    //   DROP TYPE IF EXISTS "enum_orders_payment_status";
    await queryInterface.sequelize
      .query('DROP TYPE IF EXISTS "enum_orders_payment_status";')
      .catch(() => {
        /* el tipo puede seguir referenciado — no es fatal para el rollback */
      });
  },
};
