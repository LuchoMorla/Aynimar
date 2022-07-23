const express = require('express');
const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');

const RecyclerService = require('../Services/recyclerService');
const validationHandler = require('../middlewares/validatorHandler');
const {
  getRecyclerSchema,
  createRecyclerSchema,
  updateRecyclerSchema,
} = require('../schemaODtos/recyclerSchema');

const router = express.Router();
const service = new RecyclerService();

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      res.json(await service.find());
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer'),
  validationHandler(getRecyclerSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const recycler = await service.findOne(id);
      res.json(recycler);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  validationHandler(createRecyclerSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      res.status(201).json(await service.create(body));
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  validationHandler(getRecyclerSchema, 'params'),
  validationHandler(updateRecyclerSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const updateRecycler = await service.update(id, body);
      res.status(201).json(updateRecycler);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  validationHandler(getRecyclerSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      res.status(200).json(await service.delete(id));
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;