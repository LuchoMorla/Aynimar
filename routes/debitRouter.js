const express = require('express');
const passport = require('passport');

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
checkRoles('admin', 'recycler', 'customer', 'business_owner'),
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
    checkRoles('admin', 'recycler', 'customer', 'business_owner'),
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
    checkRoles('admin', 'recycler', 'customer', 'business_owner'),
    validatorHandler(createDebitSchema, 'body'),
    async (req, res, next) => {
        try {
            const body = req.body;
            const userId = req.user.sub;
            const postDebit = await service.create(body, userId);
/*             const changeOrderState = await orderService.update(body.orderId, {
              state: "pagada"
            });
            console.log('cambiamos estado de orden:');
            console.log(changeOrderState); */
          res.json(postDebit);
        } catch (error) {
            next(error);
        }
    }
);

module.exports = router;
