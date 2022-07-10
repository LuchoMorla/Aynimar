const express = require('express');

const WasteService = require('./../Services/wasteService');

const validatorHandler = require('../middlewares/validatorHandler');
const {
  createWasteSchema,
  updateWasteSchema,
  getWasteSchema,
  queryWasteSchema,
} = require('../schemaODtos/userSchema');

const router = express.Router();
const service = new WasteService();

router.get(
  '/',
  validatorHandler(queryWasteSchema, 'query'),
  async (req, res, next) => {
    try {
      const wastes = await service.find(req.query);
      res.json(wastes);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  validatorHandler(getWasteSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const waste = await service.findOne(id);
      res.json(waste);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  validatorHandler(createWasteSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newWaste = await service.create(body);
      res.status(201).json(newWaste);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  validatorHandler(getWasteSchema, 'params'),
  validatorHandler(updateWasteSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const waste = await service.update(id, body);
      res.json(waste);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  validatorHandler(getWasteSchema, 'params'),
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
