const expressModule = require('express');

const validatorHandler = require('../middlewares/validatorHandler');
const { createWalletSchema, updateWalletSchema, getWalletSchema } = require('../schemaODtos/walletSchema');
const WalletService = require('./../Services/walletService');

const router = expressModule.Router();
const service = new WalletService();

router.get('/', async (req, res, next) => {
    try {
      const recyclers = await service.find();
      res.json(recyclers);
    } catch (error) {
      next(error);
    }
  });
  
  router.get('/:id',
    validatorHandler(getWalletSchema, 'params'),
    async (req, res, next) => {
      try {
        const { id } = req.params;
        const category = await service.findOne(id);
        res.json(category);
      } catch (error) {
        next(error);
      }
    }
  );
  
  router.post('/',
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
  
  router.patch('/:id',
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
  
  router.delete('/:id',
    validatorHandler(getWalletSchema, 'params'),
    async (req, res, next) => {
      try {
        const { id } = req.params;
        await service.delete(id);
        res.status(201).json({id});
      } catch (error) {
        next(error);
      }
    }
  );

module.exports = router;