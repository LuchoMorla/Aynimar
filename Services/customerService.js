const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const { models } = require('../libs/sequelize');
const { config } = require('./../config/config');

const nodemailer = require('nodemailer');

class CustomerService {

  constructor() {}

  async find() {
    const rta = await models.Customer.findAll({
      include: ['user']
    });

    for (let i = 0; i < rta.length; i++) {
      delete rta[i].dataValues.user.dataValues.password;
    }
    
    return rta;
  }

  async findOne(id) {
    const user = await models.Customer.findByPk(id);
    if (!user) {
      throw boom.notFound('customer not found');
    }
    return user;
  }

  async findByUserId(userId) {
    //metodo tipo middleware para encontrar un customer por el userId
    const customer = await models.Customer.findOne({
      where: { 'user_id': userId }/* ,
      include: ['user']  comente esto por que no lo ocupo y deja a la fuga informacion importante*/
    });
/*     delete customer.dataValues.user.dataValues.password; */
    return customer;
  }

  async create(data) {
    const mailPassword = data.user.password;
    const hash = await bcrypt.hash(data.user.password, 10);
    const newData = {
      ...data,
      user: {
        ...data.user,
        password: hash
      }
    }
    const newCustomer = await models.Customer.create(newData, {
      include: ['user']
    });

    const mailto = data.user.email;

    const link = `http://localhost:3000/login?email=${mailto}&password=${mailPassword}`;

    const mailContent = {
      from: config.smtpMail, // sender address
      to: `${mailto}`, // list of receivers
      subject: "Bienvenido a Aynimar", // Subject line
/*         text: "Hola santi", // plain text body   lo comente por que vamos a enviar solamente el html*/
      html: `<p> Bienvenido a Aynimar</p>
      </br>
      <p>te has registrado/inscrito exitosamente con los sguientes datos:</p>
      <p>mail: ${mailto}</p>
      <p>Constaseña: ${mailPassword}</p>
      <p>Gracias por ser parte de este cambio, te ofrecemos hacer <a href="${link}">click aquí</a> para que puedas
      <a href="${link}">iniciar sesion en la aplicación</a> de forma automática.</p>`, // html body
    }

    await this.sendMail(mailContent);

    delete newCustomer.dataValues.user.dataValues.password;
    return newCustomer;
  }

  async createCustomerByRecycler(data) {
    const recyclerCustomer = await models.Customer.create({
      name: data.dataValues.name,
      lastName: data.dataValues.lastName,
      phone: data.dataValues.phone,
      userId: data.dataValues.userId
    });
/*     delete recyclerCustomer.dataValues.user.dataValues.password; */
    return recyclerCustomer;
  }

  async update(id, changes) {
    const model = await this.findOne(id);
    const rta = await model.update(changes);
    return rta;
  }

  async delete(id) {
    const model = await this.findOne(id);
    await model.destroy();
    return { rta: true };
  }

  //Other services to costumers
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

module.exports = CustomerService;
