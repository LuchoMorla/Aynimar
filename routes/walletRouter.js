const expressModule = require('express');
const passport = require('passport');

const { checkRoles, assertUserAccess } = require('../middlewares/authHandler');

const validatorHandler = require('../middlewares/validatorHandler');
const {
  createWalletSchema,
  updateWalletSchema,
  getWalletSchema,
} = require('../schemaODtos/walletSchema');
const WalletService = require('./../Services/walletService');

const router = expressModule.Router();
const service = new WalletService();

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      const recyclers = await service.find();
      res.json(recyclers);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/my-wallet',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const wallet = await service.findByUser(userId);
      res.json({ credit: wallet?.credit ?? 0 });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getWalletSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const wallet = await service.findOne(id);
      // IDOR (R5): solo la wallet propia; admin, cualquiera. Ajena → 404.
      assertUserAccess(wallet.userId, req.user);
      res.json(wallet);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(createWalletSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newWallet = await service.create(body);
      res.status(201).json(newWallet);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(getWalletSchema, 'params'),
  validatorHandler(updateWalletSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const wallet = await service.update(id, body);
      res.json(wallet);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(getWalletSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      await service.delete(id);
      res.status(201).json({ id });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
