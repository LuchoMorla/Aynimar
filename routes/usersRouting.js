const expressModule = require('express');

const UserService = require('./../Services/userServices');
const validatorHandler = require('../middlewares/validatorHandler');
const { updateUserSchema, createUserSchema, getUserSchema } = require('../schemaODtos/userSchema');

const router = expressModule.Router();
const service = new UserService();

/*// Vamos a recibir parametros tipo Query*/
/* router.get('/', (req, res) => {
    const { limit, offset } = req.query;
    if (limit && offset) {
        res.json({
            limit,
            offset
        });
    } else {
        res.send('OHH!!! No hay parametros');
    }
}) */
router.get('/', async (req, res, next) => {
    try {
      const users = await service.find();
      res.json(users);
    } catch (error) {
      next(error);
    }
  });
  
  router.get('/:id',
    validatorHandler(getUserSchema, 'params'),
    async (req, res, next) => {
      try {
        const { id } = req.params;
        const user = await service.findOne(id);
        res.json(user);
      } catch (error) {
        next(error);
      }
    }
  );
  
  router.post('/',
    validatorHandler(createUserSchema, 'body'),
    async (req, res, next) => {
      try {
        const body = req.body;
        const newUser = await service.create(body);
        res.status(201).json(newUser);
      } catch (error) {
        next(error);
      }
    }
  );
  
  router.patch('/:id',
    validatorHandler(getUserSchema, 'params'),
    validatorHandler(updateUserSchema, 'body'),
    async (req, res, next) => {
      try {
        const { id } = req.params;
        const body = req.body;
        const category = await service.update(id, body);
        res.json(category);
      } catch (error) {
        next(error);
      }
    }
  );
  
  router.delete('/:id',
    validatorHandler(getUserSchema, 'params'),
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