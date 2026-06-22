const express = require('express');
const passport = require('passport');
const { checkRoles } = require('../middlewares/authHandler');
const { FLAGS } = require('../libs/featureFlags');

const router = express.Router();

// GET /api/v1/flags — returns current flag state (admin-only, read-only)
router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  (req, res) => {
    res.json({ flags: FLAGS, env_prefix: 'FLAG_' });
  }
);

module.exports = router;
