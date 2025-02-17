const boom = require('@hapi/boom');
const { models } = require('../libs/sequelize');
const { Op } = require('sequelize');

class OrderService {
  constructor() {}

  async create(data) {
    const customer = await models.Customer.findOne({
      where: {
        '$user.id$': data.userId,
      },
      include: ['user'],
    });
    if (!customer) {
      throw boom.badRequest('Customer not found os');
    }
    const newOrder = await models.Order.create({ customerId: customer.id });
    return newOrder;
  }

  async findByUser(userId) {
    const orders = await models.Order.findAll({
      where: {
        '$customer.user.id$': userId,
      },
      include: [
        {
          association: 'customer',
          include: ['user'],
        },
        'items',
      ],
    });

    for (var i = 0; i < orders.length; i++) {
      delete orders[i].dataValues.customer.dataValues.user.dataValues.password;
    }

    return orders;
  }

  async find() {
    const orders = await models.Order.findAll({
      include: [
        {
          association: 'customer',
          include: ['user'],
        },
        'items',
      ],
    });

    for (var i = 0; i < orders.length; i++) {
      delete orders[i].dataValues.customer.dataValues.user.dataValues.password;
    }

    return orders;
  }

  async verifyProductIsInOrderActive(productId, businnesId) {
    const orders = await this.findOrdersByBusinessId(businnesId);
    const activeOrders = orders.filter(
      (order) => !['entregado', 'cancelado'].includes(order.stateOrder)
    );

    return activeOrders.some((order) =>
      order.items.some((item) => item.id === +productId)
    );
  }

  async findOne(id) {
    const order = await models.Order.findByPk(id, {
      include: [
        {
          association: 'customer',
          include: ['user'],
        },
        'items',
      ],
    });
    delete order.dataValues.customer.dataValues.user.dataValues.password;
    /*     const nueva = order.forEach((item) => {
          item.dataValues.items.forEach((itemsitos) => itemsitos.price / 100);
        });
        console.log(nueva);
     */
    return order;
  }
  //super llamado por user id filtrando estado de orden
  async findOrderByUserIdAndState(userId, state) {
    const orders = await this.findByUser(userId);
    const ordersByState = orders.filter((order) => order.state == state);

    /*     const nueva = ordersByState.forEach((item) => {
          item.dataValues.items.forEach((itemsitos) => itemsitos.price / 100);
        });
        console.log(nueva);

        console.log(nueva.dataValues.items.dataValues.price); */
    if (ordersByState.length == 0) {
      throw boom.badRequest(`Order in state ${state} not found`);
    }
    return ordersByState[0];
  }
  //llamado de orden por id validando que coincida con su sub
  async findByOrderIdValidatedWidthUserId(userId, orderId) {
    const order = await this.findOne(orderId);
    if (!order) {
      throw boom.badRequest('order not found');
    }
    const userToValidate = order.customer.userId;
    if (userToValidate == userId) {
      return order;
    } else {
      throw boom.badRequest('is not your orderId');
    }
  }

  async findOrdersByBusinessId(businessId) {
    const orders = await models.Order.findAll({
      where: {
        state: {
          [Op.eq]: 'pagada',
        },
      },
      include: [
        {
          association: 'customer',
          include: [
            {
              association: 'user',
              attributes: {
                exclude: ['password', 'recoveryToken'],
              },
            },
          ],
        },
        {
          association: 'items',
          where: {
            businessId,
          },
        },
      ],
    });

    return orders;
  }
  //Servicio para obtener las ordenes filtradas por un estado

  async findOrdersByState(state) {
    const orders = await this.find();
    if (!orders) {
      throw boom.badRequest('order not found');
    }
    const ordersByState = orders.filter((order) => order.state == state);
    if (ordersByState.length == 0) {
      throw boom.badRequest(`Order in state ${state} not found`);
    }
    return ordersByState;
  }

  async update(id, changes) {
    const order = await this.findOne(id);
    const rta = await order.update(changes);

    if (changes.state === 'pagada') {
      const orderItems = await models.OrderProduct.findAll({
        where: {
          orderId: id,
        },
      });

      for (let i = 0; i < orderItems.length; i++) {
        const product = await models.Product.findByPk(orderItems[i].productId);
        await product.update({
          stock: product.stock - orderItems[i].amount,
        });
      }
    }

    return {
      id,
      changes,
      rta,
    };
  }

  async delete(id) {
    const model = await this.findOne(id);
    await model.destroy();
    return { rta: true };
  }

  // Items
  async findOneItem(id) {
    const item = await models.OrderProduct.findByPk(id);
    return item;
  }

  async addItem(data) {
    const newItem = await models.OrderProduct.create(data);
    return newItem;
  }

  async updateItem(id, changes) {
    const item = await this.findOneItem(id);
    const rta = await item.update(changes);
    return {
      id,
      changes,
      rta,
    };
  }

  async deleteItem(id) {
    const item = await this.findOneItem(id);
    await item.destroy();
    return { rta: true };
  }
}

module.exports = OrderService;
