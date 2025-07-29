const boom = require('@hapi/boom');
const { models } = require('../libs/sequelize');
const { Op } = require('sequelize');

const { config } = require('./../config/config');
const nodemailer = require('nodemailer');


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
          [Op.in]: ['pagada', 'pendiente_envio'],
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
    if (changes.state === 'pagada'|| changes.state === 'pendiente_envio') {
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

    if (changes.state === 'pendiente_envio') {
      const customerEmail = order.customer.user.email;
      const customerName = order.customer.name;
      const mailCustomer = {
          from: config.smtpMail,
          to: `${customerEmail}`,
          subject: "Compra realizada con exito",
          html: `<p>Muchas gracias por tú compra, se ah realizado con exito</p>
          </br>
          <p>Muchas gracias Estimado(a) ${customerName} por tú compra</p>
          Queremos agradecerte por tu compra en Aynimar. <br> Tu número de orden es <strong>${id}</strong></p>
          <p>Queremos que sepas que estamos procesando tu compra y que te enviaremos una confirmación de envío o entrega tan pronto como sea posible. Si tienes alguna pregunta o inquietud, no dudes en ponerte en contacto con nuestro equipo de soporte en https://www.aynimar.com/contact.</p>
          <p>Gracias por confiar en nosotros y por elegir Aynimar para tus compras. Esperamos que disfrutes de tus productos.</p>
          <p>Saludos cordiales,</p>
          <p>El equipo de Aynimar</p>
          <img src="https://www.aynimar.com/_next/static/media/logo-Aynimar.c247031e.svg" alt="Aynimar-logo">
          <p>Hasta mientras estaremos preparando tu pedido para enviartelo, y muy pronto uno de nuestros agentes se comunicará con tigo</p>
          <p>Recuerda que tambien puedes pedir devolucion a nuestro equipo antes de que la entrega sea realizada y crear una disputa en caso de que quieras devolver tú producto, comunicate con nosotros en https://www.aynimar.com/contact</p>
          `,
        }
      await this.sendMail(mailCustomer);
      console.log('Email del Cliente:', customerEmail);

      const businessIds = [...new Set(order.items.map(item => item.businessId))];
      const businesses = await models.Business.findAll({
        where: {
          id: {
            [Op.in]: businessIds
          }
        },
        include: {
          association: 'businessOwner',
          include: {
            association: 'user',
            attributes: ['email']
          }
        }
      });
      const ownersData = {};
      for (const item of order.items) {
        const business = businesses.find(b => b.id === item.businessId);
        if (business && business.businessOwner && business.businessOwner.user) {
          const ownerEmail = business.businessOwner.user.email;
          const ownerName = business.businessOwner.name;
          const businessId = business.id;
          const businessName = business.name;
          if (!ownersData[ownerEmail]) {
            ownersData[ownerEmail] = {
              email: ownerEmail,
              name: ownerName,
              businesses: {} 
            };
          }
          if (!ownersData[ownerEmail].businesses[businessId]) {
            ownersData[ownerEmail].businesses[businessId] = {
              name: businessName,
              products: []
            };
          }
          ownersData[ownerEmail].businesses[businessId].products.push({
            name: item.name,
            amount: item.OrderProduct.amount,
            price: item.price
          });
        }
      }
      for (const ownerEmail in ownersData) {
        const owner = ownersData[ownerEmail];
        const businessesHtml = Object.values(owner.businesses).map(business => {
          const productListHtml = business.products
            .map(p => `<li>${p.amount} x ${p.name} - (Precio unitario: $${p.price / 100})</li>`)
            .join('');

          return `
            <h4>Negocio: ${business.name}</h4>
            <ul>
              ${productListHtml}
            </ul>
          `;
        }).join('<hr style="border: 1px solid #eee; margin: 20px 0;">');

        const mailForOwner = {
          from: config.smtpMail,
          to: owner.email,
          subject: `¡Nueva venta! Has recibido un pedido (Orden #${id})`,
          html: `
            <p>¡Hola, ${owner.name}!</p>
            <p>Has recibido una venta para los siguientes productos en la orden <strong>#${id}</strong>, agrupados por cada uno de tus negocios:</p>
            ${businessesHtml}
            <p>Por favor, prepara los productos para el envío. Puedes ver los detalles completos de la orden en tu panel de vendedor.</p>
            <p>Saludos cordiales,</p>
            <p>El equipo de Aynimar</p>
            <img src="https://www.aynimar.com/_next/static/media/logo-Aynimar.c247031e.svg" alt="Aynimar-logo">
          `
        };

        await this.sendMail(mailForOwner);
      }
      console.log('Emails enviados a los dueños de negocios:', Object.keys(ownersData)); 
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

  async sendMail(infoMail) {
        const transporter = nodemailer.createTransport({
          host: "smtp.gmail.com",
          secure: true, // true for 465, false for other ports
          port: 465,
          auth: {
            user: config.smtpMail,
            pass: config.smtpMailKey
          }
        });
        await transporter.sendMail(infoMail);
        return { message:  `mail sent to ${infoMail.to}` };
      }
      
}
module.exports = OrderService;
