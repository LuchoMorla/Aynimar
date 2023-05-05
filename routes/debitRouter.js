const express = require('express');
const passport = require('passport');
const CustomerService = require('../Services/customerService');

const { checkRoles } = require('../middlewares/authHandler');

const DebitService = require('../Services/debitService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
    getDebitSchema,
    createDebitSchema 
} = require('../schemaODtos/debitSchema');

const router = express.Router();
const service = new DebitService();

router.get('/',
passport.authenticate('jwt', { session: false }),
checkRoles('admin', 'recycler', 'customer'),
 async (req, res, next) => {
  try {
    const body = req.body;
    console.log(body);
    res.json(await service.find());
  } catch (error) {
    next(error);
  }
});

router.get(
    '/:id',
    passport.authenticate('jwt', { session: false }),
    checkRoles('admin', 'recycler', 'customer'),
    validatorHandler(getDebitSchema, 'params'),
    async (req, res, next) => {
      try {
        const { id } = req.params;
        const debit = await service.findOne(id);
        res.json(debit);
      } catch (error) {
        next(error);
      }
    }
  );

router.post('/',
    passport.authenticate('jwt', { session: false }),
    checkRoles('admin', 'recycler', 'customer'),
    validatorHandler(createDebitSchema, 'body'),
    async (req, res, next) => {
        try {
            const body = req.body;
            const postDebit = await service.create(body);
          res.json(postDebit);
        } catch (error) {
            next(error);
        }
    }
);

module.exports = router;