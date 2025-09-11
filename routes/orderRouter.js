const express = require('express');

const passport = require('passport');

const { checkRoles } = require('../middlewares/authHandler');

const OrderService = require('../Services/orderService');
const CustomerService = require('../Services/customerService');
const RecyclerService = require('../Services/recyclerService');
const validatorHandler = require('../middlewares/validatorHandler');
const {
  getOrderSchema,
  getOrderByUserIdAndOrderId,
  createOrderSchema,
  addItemGuestSchema,     // <-- Importar
  associateOrderSchema,   // <-- Importar
  getOrderByState,
  updateOrderSchema,
  updateItemSchema,
  addItemSchema,
  getItemSchema,
  getOrdersByBusinessId,
  getVerifyProductIsInOrderActive,
} = require('../schemaODtos/orderSchema');

const router = express.Router();
const service = new OrderService();
const customerService = new CustomerService();
const recyclerService = new RecyclerService();

// --- NUEVAS RUTAS PÚBLICAS (colócalas antes de las rutas protegidas) ---

// Ruta para que un invitado cree su carrito inicial
router.post(
  '/guest-order',
  async (req, res, next) => {
    try {
      const newOrder = await service.createGuestOrder();
      res.status(201).json(newOrder);
    } catch (error) {
      next(error);
    }
  }
);

// Ruta para que un invitado agregue productos a su carrito
router.post(
  '/add-item-guest',
  validatorHandler(addItemGuestSchema, 'body'), // Usamos el nuevo schema
  async (req, res, next) => {
    try {
      const body = req.body;
      const newItem = await service.addItemToGuestOrder(body);
      res.status(201).json(newItem);
    } catch (error) {
      next(error);
    }
  }
);

// --- FIN DE RUTAS PÚBLICAS ---

// --- NUEVA RUTA PROTEGIDA (puede ir con las otras rutas PATCH o POST protegidas) ---

// Ruta para asociar la orden de invitado con el usuario que acaba de loguearse/registrarse
router.patch(
  '/associate-order',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'), // Todos los roles pueden reclamar su carrito
  validatorHandler(associateOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const { sub: userId } = req.user;
      const { orderId } = req.body;
      const updatedOrder = await service.associateOrderToCustomer(orderId, userId);
      res.json(updatedOrder);
    } catch (error) {
      next(error);
    }
  }
);

// --- AÑADIR ESTA NUEVA RUTA PÚBLICA (junto a las otras de invitado) ---
router.get(
  '/guest-order/:id',
  validatorHandler(getOrderSchema, 'params'), // Reutilizamos el schema que solo valida el ID
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const order = await service.findGuestOrderById(id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);

// --- NUEVA RUTA PÚBLICA (La que añadimos) ---
router.delete(
  '/item-guest/:id', // Usamos una nueva URL para no chocar con la protegida
  validatorHandler(getItemSchema, 'params'), // Reutilizamos el mismo validador
  async (req, res, next) => {
    try {
      const { id } = req.params;
      // ¡Aquí está la magia! Llamamos al mismo método de servicio.
      const deleteItem = await service.deleteItem(id); 
      res.status(200).json(deleteItem);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  async (req, res, next) => {
    try {
      const orders = await service.find();
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const order = await service.findOne(id);
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);
// llamado para obtener todas las ordenes con un estado
router.get(
  '/by/state',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin'),
  validatorHandler(getOrderByState, 'body'),
  async (req, res, next) => {
    try {
      /*
      const { id } = req.params; */ /*
      const orders = await service.find(); */
      const body = req.body;
      const { state } = body;
      const orders = await service.findOrdersByState(state);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

// Router for get the orders of a business
router.get(
  '/by/business/:businessId',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getOrdersByBusinessId, 'params'),
  async (req, res, next) => {
    try {
      const { businessId } = req.params;

      const orders = await service.findOrdersByBusinessId(businessId);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

//super llamado por user id filtrando estado de orden
router.get(
  '/user/state',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderByState, 'query'),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const body = req.query;
      const { state } = body;
      const order = await service.findOrderByUserIdAndState(userId, state);
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);
//llamado de orden por id validando que coincida con su sub
router.get(
  '/user/order',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderByUserIdAndOrderId, 'body'),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const body = req.body;
      const orderId = body.id;
      const order = await service.findByOrderIdValidatedWidthUserId(
        userId,
        orderId
      );
      res.json(order);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/userId/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const orders = await service.findByUser(id);
      res.json(orders);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/verify-product-is-in-order-active/:id/:businessId',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'),
  validatorHandler(getVerifyProductIsInOrderActive, 'params'),
  async (req, res, next) => {
    try {
      const { id, businessId } = req.params;

      const isVerified = await service.verifyProductIsInOrderActive(
        id,
        businessId
      );
      res.json({
        isVerified,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(createOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = {
        userId: req.user.sub,
        userRole: req.user.role,
      };
      const haveCustomerId = await customerService.findByUserId(body.userId);
      if (body.userRole === 'recycler' && !haveCustomerId) {
        const findRecycler = await recyclerService.findByUserId(body.userId);
        const newCustomer = await customerService.createCustomerByRecycler(
          findRecycler
        );
        return newCustomer;
      }
      const newOrder = await service.create(body);
      res.status(201).json(newOrder);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  validatorHandler(updateOrderSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const rta = await service.update(id, body);
      res.status(201).json(rta);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getOrderSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleteOrder = await service.delete(id);
      res.status(201).json(deleteOrder);
    } catch (error) {
      next(error);
    }
  }
);

// ITEMS

router.get(
  '/add-item/:id',
  validatorHandler(getItemSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const item = await service.findOneItem(id);
      res.json(item);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/add-item',
  passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(addItemSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const newItem = await service.addItem(body);
      res.status(201).json(newItem);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/add-item/:id',
  // passport.authenticate('jwt', { session: false }),
  // checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getItemSchema, 'params'),
  validatorHandler(updateItemSchema, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body;
      const updateItem = await service.updateItem(id, body);
      res.status(201).json(updateItem);
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/add-item/:id',
  // passport.authenticate('jwt', { session: false }),
  // checkRoles('admin', 'recycler', 'customer', 'business_owner'),
  validatorHandler(getItemSchema, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleteItem = await service.deleteItem(id);
      res.status(201).json(deleteItem);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
