'use strict';

const boom = require('@hapi/boom');
const { models } = require('./../libs/sequelize');

class WalletService {
  constructor() {}

  async create(data) {
    const newWallet = await models.Wallet.create({ ...data });
    return newWallet;
  }

  /**
   * Returns all wallets with their owner's user data (admin view).
   */
  async find() {
    return models.Wallet.findAll({
      include: [
        { association: 'user', attributes: ['id', 'email', 'role'] },
        { association: 'recycler', attributes: ['id', 'name', 'lastName'] },
      ],
    });
  }

  /**
   * Finds the wallet for a given user (works for any role).
   * This is the primary lookup used at checkout to read/apply credits.
   *
   * @param {number} userId
   * @returns {Object|null}
   */
  async findByUser(userId) {
    const wallet = await models.Wallet.findOne({
      where: { userId },
      include: [{ association: 'user', attributes: ['id', 'email', 'role'] }],
    });
    return wallet;
  }

  /**
   * Finds or creates a wallet for a user.
   * Called automatically when a user earns their first green credit.
   *
   * @param {number} userId
   * @returns {{ wallet: Object, created: boolean }}
   */
  async findOrCreateForUser(userId) {
    const [wallet, created] = await models.Wallet.findOrCreate({
      where:    { userId },
      defaults: { userId, credit: 0 },
    });
    return { wallet, created };
  }

  async findOne(id) {
    const wallet = await models.Wallet.findByPk(id, {
      include: [
        { association: 'user',     attributes: ['id', 'email', 'role'] },
        { association: 'recycler', attributes: ['id', 'name', 'lastName'] },
      ],
    });
    if (!wallet) throw boom.notFound('Wallet not found');
    return wallet;
  }

  async update(id, changes) {
    const wallet = await this.findOne(id);
    return wallet.update(changes);
  }

  /**
   * Adds credits to a user's wallet (green credits earned from recycling).
   * Creates the wallet if it doesn't exist yet.
   *
   * @param {number} userId
   * @param {number} amount   Positive integer
   */
  async addCredits(userId, amount) {
    if (amount <= 0) throw boom.badData('Credit amount must be positive');
    const { wallet } = await this.findOrCreateForUser(userId);
    return wallet.update({ credit: wallet.credit + amount });
  }

  /**
   * Redeems (deducts) credits from a user's wallet at checkout.
   *
   * When called inside a Sequelize transaction (via the `transaction` option),
   * the wallet row is locked with SELECT FOR UPDATE to prevent race conditions
   * where two concurrent requests could both read the same balance and both
   * succeed despite only having enough credits for one purchase.
   *
   * @param {number} userId
   * @param {number} amount              Integer credits to spend
   * @param {Object} [opts]
   * @param {import('sequelize').Transaction} [opts.transaction]  Active transaction
   */
  async redeemCredits(userId, amount, { transaction } = {}) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw boom.badData('Redemption amount must be a positive integer');
    }

    const queryOpts = transaction ? { transaction, lock: true } : {};

    const wallet = await models.Wallet.findOne({
      where: { userId },
      ...queryOpts,
    });

    if (!wallet) throw boom.notFound('Wallet not found for this user');

    if (wallet.credit < amount) {
      throw boom.paymentRequired(
        `Insufficient credits. Available: ${wallet.credit}, requested: ${amount}`
      );
    }

    return wallet.update(
      { credit: wallet.credit - amount },
      transaction ? { transaction } : {}
    );
  }

  async delete(id) {
    const wallet = await this.findOne(id);
    await wallet.destroy();
    return { id };
  }
}

module.exports = WalletService;
