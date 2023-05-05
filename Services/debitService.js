const boom = require('@hapi/boom');
const { config } = require('./../config/config');
const { models } = require('../libs/sequelize');

const nodemailer = require('nodemailer');

class DebitService {

  constructor(){
  }

  async create(data, uId) {
/*    const customerIdBody = data.customerId;
     if (customerIdBody == idT) { */
     const user = await models.User.findByPk(uId);
      const newDebit = await models.Debit.create(data);

      const mailContentAdmin = {
        from: config.smtpMail, // sender address
        to: `${config.receivermail}, ${config.smtpMail}`, // list of receivers
        subject: "Se ha realizado una venta", // Subject line
        html: `<p> Alguién ah Realizado una compra</p>
        </br>
        <p>customerId: ${data.customerId}</p>
        <p>orderId: ${data.orderId}</p>
        <p>transactionId: <strong> ${data.transactionId} </strong></p>
        </br>
        <p>amount: ${data.amount}</p>
        <p>paymentDate: ${data.paymentDate}</p>
        <p>paymentStatus: ${data.paymentStatus}</p>
        <p>authorizationCode: ${data.authorizationCode}</p>

        `, // html body
      }
      await this.sendMail(mailContentAdmin);
      const mailUser = {
        from: config.smtpMail, // sender address
        to: `${user.email}`, // list of receivers
        subject: "Compra realizada con exito", // Subject line
        html: `<p>Muchas gracias por tú compra, se ah realizado con exito</p>
        </br>
        <p>Muchas gracias Estimado(a) ${user.email} por tú compra, tú pago ah sido realizado de forma segura y exitosa.</p>
        Queremos agradecerte por tu compra en Aynimar. <br> Tu número de orden es <strong>${data.orderId}</strong>, y tu compra se realizó el ${data.paymentDate}.</br> Adjunto a este correo electrónico encontrarás una copia de la factura de tu compra.</p>
        <p>Queremos que sepas que estamos procesando tu compra y que te enviaremos una confirmación de envío o entrega tan pronto como sea posible. Si tienes alguna pregunta o inquietud, no dudes en ponerte en contacto con nuestro equipo de soporte en https://www.aynimar.com/contact.</p>
        <p>Gracias por confiar en nosotros y por elegir Aynimar para tus compras. Esperamos que disfrutes de tus productos.</p>
        <p>Saludos cordiales,</p>
        <p>El equipo de Aynimar</p>
        <img src="https://www.aynimar.com/_next/static/media/logo-Aynimar.c247031e.svg" alt="Aynimar-logo">
        <p>Datos de Factura:</p>
        <p>
        <p>transactionId: ${data.transactionId} </p>
        <p>authorizationCode: ${data.authorizationCode}</p>
        <p>amount: ${data.amount}</p>
        </p>
        <p>Hasta mientras estaremos preparando tu pedido para enviartelo, y muy pronto uno de nuestros agentes se comunicará con tigo</p>
        <p>Recuerda que tambien puedes pedir devolucion a nuestro equipo antes de que la entrega sea realizada y crear una disputa en caso de que quieras devolver tú producto, comunicate con nosotros en https://www.aynimar.com/contact</p>
        `, // html body
      }
      await this.sendMail(mailUser);

      return newDebit;
    /* } else {
      throw boom.badRequest('you are not a customer, somenthing went wrong here!!!');
    } */
  }

  async findByUser(userId) {
/*     const orders = await models.Order.findAll({
      where: {
        '$customer.user.id$': userId
      },
      include: [
        {
          association: 'customer',
          include: ['user']
        },
        'items'
      ]
    });

    for (var i = 0; i < orders.length; i++) {
      delete orders[i].dataValues.customer.dataValues.user.dataValues.password;
    }
    
    return orders; */
  }

  async find() {
    const debits = await models.Debit.findAll();

    return debits;
  }

  async findOne(id) {
    const userDebit = await models.Debit.findByPk(id);
    return userDebit;
  }

  
    //Other services to debit cards and receibe payments
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

module.exports = DebitService;