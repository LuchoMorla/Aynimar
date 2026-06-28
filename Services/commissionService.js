'use strict';

const boom = require('@hapi/boom');
const sequelize = require('../libs/sequelize');
const { models } = sequelize;
const WalletService = require('./walletService');

const walletService = new WalletService();

// Immutable — never read from client input
const COMMISSION_RATE = 0.30;

/**
 * CommissionService — sole authority for recycling compensation logic.
 *
 * All financial calculations happen here, on the server.
 * The client never sends commission amounts or net credits — it only
 * sends the paymentWasteId. Everything else is derived from the database.
 *
 * Flow:
 *   1. Validate the PaymentWaste record exists and hasn't been liquidated.
 *   2. Calculate commission (30%) and net credits (FLOOR(gross * 0.70)).
 *   3. Inside a single transaction:
 *      a. Credit the user's wallet with netCredits.
 *      b. Write a WalletTransaction row for full auditability.
 *   4. Return the complete liquidation summary.
 */
class CommissionService {
  constructor() {}

  /**
   * Calculates commission breakdown from a gross USD amount.
   * This is the ONLY place in the codebase where the 30% rate is applied.
   *
   * @param {number} grossAmount  Gross USD value of the recyclable.
   * @returns {{ grossAmount: number, commission: number, netCredits: number }}
   */
  calculateBreakdown(grossAmount) {
    const gross = parseFloat(grossAmount);
    if (isNaN(gross) || gross <= 0) {
      throw boom.badData('grossAmount must be a positive number');
    }
    const commission = parseFloat((gross * COMMISSION_RATE).toFixed(2));
    const netCredits = Math.floor(gross * (1 - COMMISSION_RATE));
    return { grossAmount: gross, commission, netCredits };
  }

  /**
   * Liquidates a recycling transaction:
   *  - Validates the PaymentWaste and ownership chain.
   *  - Applies the 30% commission rule.
   *  - Credits the user's wallet atomically.
   *  - Persists a full audit record in wallet_transactions.
   *
   * @param {number} paymentWasteId  ID of the payments_wastes row to liquidate.
   * @param {number} grossAmount     Gross USD value agreed with the recycler.
   * @returns {Promise<Object>} Liquidation summary.
   */
  async liquidate(paymentWasteId, grossAmount) {
    const { commission, netCredits, grossAmount: gross } =
      this.calculateBreakdown(grossAmount);

    // ── Validate PaymentWaste exists ──────────────────────────────────────────
    const paymentWaste = await models.PaymentWaste.findByPk(paymentWasteId, {
      include: [{ association: 'payment', include: ['recycler'] }],
    });
    if (!paymentWaste) {
      throw boom.notFound(`PaymentWaste ${paymentWasteId} not found`);
    }

    // ── Resolve userId from the recycler ownership chain ──────────────────────
    const userId = paymentWaste.payment?.recycler?.userId;
    if (!userId) {
      throw boom.badImplementation(
        `Cannot resolve userId for PaymentWaste ${paymentWasteId}. ` +
        'Ensure payment→recycler→userId association is intact.'
      );
    }

    // ── Prevent double-liquidation ────────────────────────────────────────────
    const alreadyLiquidated = await models.WalletTransaction.findOne({
      where: { referenceId: paymentWasteId, referenceType: 'payment_waste' },
    });
    if (alreadyLiquidated) {
      throw boom.conflict(
        `PaymentWaste ${paymentWasteId} has already been liquidated ` +
        `(transaction #${alreadyLiquidated.id})`
      );
    }

    // ── Atomic: credit wallet + write audit row ───────────────────────────────
    const result = await sequelize.transaction(async (t) => {
      const { wallet } = await walletService.findOrCreateForUser(userId);

      const updatedWallet = await wallet.update(
        { credit: wallet.credit + netCredits },
        { transaction: t }
      );

      const txRecord = await models.WalletTransaction.create(
        {
          walletId:      wallet.id,
          type:          'sale',
          direction:     'credit',
          grossAmount:   gross,
          commission,
          netCredits,
          referenceId:   paymentWasteId,
          referenceType: 'payment_waste',
          notes: `Liquidación de reciclable. Comisión Aynimar ${COMMISSION_RATE * 100}%.`,
        },
        { transaction: t }
      );

      return {
        transactionId:  txRecord.id,
        paymentWasteId,
        userId,
        walletId:       wallet.id,
        grossAmount:    gross,
        commission,
        netCredits,
        walletCredit:   updatedWallet.credit,
        commissionRate: `${COMMISSION_RATE * 100}%`,
      };
    });

    return result;
  }

  /**
   * Returns the paginated transaction history for a wallet.
   *
   * @param {number} userId
   * @param {{ page?: number, limit?: number }} opts
   */
  async getTransactionsByUser(userId, { page = 1, limit = 20 } = {}) {
    const wallet = await walletService.findByUser(userId);
    if (!wallet) {
      return { transactions: [], totalCredits: 0, page, limit };
    }

    const offset = (page - 1) * limit;

    const { count, rows } = await models.WalletTransaction.findAndCountAll({
      where: { walletId: wallet.id },
      order: [['created_at', 'DESC']],
      limit,
      offset,
    });

    return {
      transactions: rows,
      totalCredits: wallet.credit,
      total: count,
      page,
      limit,
      pages: Math.ceil(count / limit),
    };
  }

  /**
   * Returns aggregated finance stats for the admin FinancePanel.
   * Summarizes total gross, commissions earned, and credits issued.
   */
  async getFinanceSummary() {
    const [result] = await sequelize.query(`
      SELECT
        COALESCE(SUM(gross_amount), 0)::NUMERIC(10,2)  AS total_gross,
        COALESCE(SUM(commission),   0)::NUMERIC(10,2)  AS total_commission,
        COALESCE(SUM(net_credits),  0)::INTEGER        AS total_credits_issued,
        COUNT(*)::INTEGER                               AS total_transactions
      FROM wallet_transactions
      WHERE type = 'sale'
    `);
    return result[0] ?? {
      total_gross: 0,
      total_commission: 0,
      total_credits_issued: 0,
      total_transactions: 0,
    };
  }
}

module.exports = CommissionService;
