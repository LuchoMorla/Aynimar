const express = require('express'),
  passport = require('passport'),
  AuthService = require('./../Services/authService'),
  service = new AuthService(),
  router = express.Router(),
  { checkRoles } = require('../middlewares/authHandler'),
  validatorHandler = require('../middlewares/validatorHandler'),
  {
    loginAuthSchema,
    recoveryAuthSchema,
    changePasswordAuthSchema,
    autoLoginAuthSchema
  } = require('../schemaODtos/authSchema');

router.post(
  '/login',
  passport.authenticate('local', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(loginAuthSchema, 'body'),
  async (req, res, next) => {
    try {
      const user = req.user;
      res.json(service.signToken(user));
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/recovery',
  validatorHandler(recoveryAuthSchema, 'body'),
  async (req, res, next) => {
    try {
      const { email } = req.body;
      const rta = await service.sendRecovery(email);
      res.json(rta);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/change-password',
  validatorHandler(changePasswordAuthSchema, 'body'),
  async (req, res, next) => {
    try {
      const { token, newPassword } = req.body;
      const rta = await service.changePassword(token, newPassword);
      res.json(rta);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/auto-login',
  validatorHandler(autoLoginAuthSchema, 'body'),
  async (req, res, next) => {
    try {
      const { token } = req.body;
      const rta = await service.autoLogin(token);
      res.json(rta);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;