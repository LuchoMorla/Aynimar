const boom = require('@hapi/boom');

const { config } = require('./../config/config');
const { models } = require('../libs/sequelize');

const nodemailer = require('nodemailer');

class PaymentService {

  constructor(){
  }

  async create(data) {
    const recycler = await models.Recycler.findOne({
      where: {
        '$user.id$': data.userId
      },
      include: ['user']
    })
    if (!recycler) {
      throw boom.badRequest('Recycler not found');
    }
    const newPayment = await models.Payment.create({ recyclerId: recycler.id });
    return newPayment;
  }

  async addCommodity(data) {
    const newcommoditie = await models.PaymentWaste.create(data);
    const searchPayment = await this.findOne(newcommoditie.paymentId);
    if (!searchPayment) {
      throw boom.notFound('payment search not found');
    }
    const recyclerId = searchPayment.recyclerId;
    if (!recyclerId) {
      throw boom.notFound('recyclerId not found');
    }
    const recycler = await models.Recycler.findByPk(recyclerId);
    if (!recycler) {
      throw boom.notFound('recyclerId not found');
    }
    const userId = recycler.userId;
    const user = await models.User.findByPk(userId);
    if (!user) {
      throw boom.notFound('userId not found');
    }

    const mailContentAdmin = {
      from: config.smtpMail, // sender address
      to: `${config.receivermail}, ${config.smtpMail}`, // list of receivers
      subject: "Se ha comprado aceite", // Subject line
      html: `<p> Alguién ah solicitado la compra</p>
      </br>
      <p>es el usuario#: ${user.id}</p>
      <p>su rol principal: ${user.role}</p>
      <p>mail: <strong> ${user.email} </strong></p>
      </br>
      <p>su recycler name: ${recycler.name}</p>
      <p>su telefono: ${recycler.phone}</p>
      <p>provincia: ${recycler.city}</p>
      <p>ciudad: ${recycler.city}</p>
      <p>direccion: ${recycler.streetAddress}</p>
      <p>ubicacion: <strong> ${recycler.geolocation} </strong></p>
      <p>tipo de pago: ${recycler.paymentType}</p>
      </br>
      <p>C.Id: ${newcommoditie.id}</p>
      <p>C.PaymentId: ${newcommoditie.paymentId}</p>
      <p>C.WasteId: ${newcommoditie.wasteId}</p>
      <p>C.Amount: ${newcommoditie.amount}</p>
      `, // html body
    }
    await this.sendMail(mailContentAdmin);
    const mailUser = {
      from: config.smtpMail, // sender address
      to: `${user.email}`, // list of receivers
      subject: "Pedido de compra exitoso", // Subject line
      html: `<p>gracias por usar nuestro servicio ${recycler.name}</p>
      </br>
      <p>Usted ah realizado exitosamente un pedido de compra.</p>
      <p>recuerde actualizar sus datos en la url https://aynimar.com/mi_cuenta/recycler, en caso no los tenga actualizados, para evitar cualquier inconveniente al momento de comunicarnos con usted para cerrar el proceso de compra de su articulo a reciclar.</p>
      `, // html body
    }
    await this.sendMail(mailUser);

    return newcommoditie;
  }

  async findByUser(userId) {
    const payments = await models.Payment.findAll({
      where: {
        '$recycler.user.id$': userId
      },
      include: [
        {
          association: 'recycler',
          include: ['user']
        },
        'commodities'
      ]
    });
    for (let i = 0; i < payments.length; i++) {
      delete payments[i].dataValues.recycler.dataValues.user.dataValues.password;
    }
    return payments;
  }

  async find() {
    const payments = await models.Payment.findAll({
      include: [
        {
          association: 'recycler',
          include: ['user']
        },
        'commodities'
      ]
    });

    for (let i = 0; i < payments.length; i++) {
      delete payments[i].dataValues.recycler.dataValues.user.dataValues.password;
    }

    return payments;
  }

  async findOne(id) {
    const payment = await models.Payment.findByPk(id, {
      include: [
        {
          association: 'recycler',
          include: ['user']
        },
        'commodities'
      ]
    });
    delete payment.dataValues.recycler.dataValues.user.dataValues.password;
    return payment;
  }

  async update(id, changes) {
    const payment = await this.findOne(id);
    const rta = await payment.update(changes);
    return {
      id,
      changes,
      rta
    };
  }

  async delete(id) {
    const model = await this.findOne(id);
    await model.destroy();
    return { rta: true };
  }

    //Other services to payment
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

module.exports = PaymentService;