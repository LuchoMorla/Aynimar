const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const { models } = require('../libs/sequelize');
const { config } = require('./../config/config');

const jwt = require('jsonwebtoken');

const AuthService = require('./authService');
const UserService = require('./userServices');
const authService = new AuthService();
const userService = new UserService();

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

    //authenticate
    const user = await authService.getUser(mailto, mailPassword);
    const payload = { sub: user.id };
    //sign token and save recoveryToken
    const token = jwt.sign(payload, config.temporalyJwtSecret, {expiresIn: '30min'});
    const link = `https://localhost:3000/auto-login?token=${token}`;
    await userService.update(user.id, {recoveryToken: token});
    // send Email
    const mailContent = {
      from: config.smtpMail, // sender address
      to: `${mailto}`, // list of receivers
      subject: "Bienvenido a Aynimar", // Subject line
      html: `<p> Bienvenido a Aynimar</p>
      </br>
      <p>te has registrado/inscrito exitosamente con los sguientes datos:</p>
      <p>mail: ${mailto}</p>
      <p>Constaseña: ${mailPassword}</p>
      </br>
      <p>Gracias por ser parte de este cambio, te ofrecemos hacer <a href="${link}">click aquí</a> para que puedas
      <a href="${link}">iniciar sesion en la aplicación</a> de forma automática, este <a href="${link}">link</a> expirará en 30 minutos, aprovéchalo.</p>
      </br>
      <p><strong>Te aconsejamos no guardar y borrar este correo para que un atacante no pueda tener acceso a la aplicación y
      recuerda no guardar tus contraseñas en lugares donde atacantes puedan acceder,
       como por ejemplo el gestor de contraseñas del navegador</strong></p>`, // html body
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
