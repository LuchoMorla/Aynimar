const { models } = require('../libs/sequelize');
const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');

const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

const AuthService = require('./authService');
const UserService = require('./userServices');
const { config } = require('../config/config');
const authService = new AuthService();
const userService = new UserService();

class BusinessOwnerService {
  async findOne(id) {
    const user = await models.BusinessOwner.findByPk(id, {
      include: ["business"]
    });
    if (!user) {
      throw boom.notFound('Business Owner not found');
    }
    return user;
  }

  async createBusiness() {
    const newBusinessOwner = await models.BusinessOwner.create({}, {
      include: ['user']
    });
    return newBusinessOwner;
  }

  async findByUserId(userId) {
    const businessOwner = await models.BusinessOwner.findOne({
      where: { 'user_id': userId },
    });
    return businessOwner;
  }

  async create(data) {
    const mailPassword = data.user.password;
    const hash = await bcrypt.hash(data.user.password, 10);
    const role = 'business_owner';
    const newData = {
      ...data,
      user: {
        ...data.user,
        password: hash,
        role: role
      }
    }
    console.log(newData)
    const newBusinessOwner = await models.BusinessOwner.create(newData, {
      include: ['user']
    });

    const mailto = data.user.email;

    //authenticate
    const user = await authService.getUser(mailto, mailPassword);

    const payload = { sub: user.id };
    //sign token and save recoveryToken
    const token = jwt.sign(payload, config.temporalyJwtSecret, { expiresIn: '30min' });
    const link = `https://aynimar.com/autoLogin?token=${token}`;
    await userService.update(user.id, { recoveryToken: token });

    // send Email
    const mailContent = {
      from: config.smtpMail, // sender address
      to: `${mailto}`, // list of receivers
      subject: "Bienvenido a Aynimar", // Subject line
      html: `<p> Bienvenido a Aynimar</p>
      </br>
      <p>te has registrado/inscrito exitosamente con los siguientes datos:</p>
      <p>mail: <strong> ${mailto} </strong></p>
      <p>Constaseña: <strong> ${mailPassword} </strong></p>
      </br>
      <p>Gracias por ser parte de este cambio, te ofrecemos hacer <a href="${link}">click aquí</a> para que puedas
      <a href="${link}">iniciar sesion en la aplicación</a> de forma automática, este <a href="${link}">link</a> expirará en 30 minutos, aprovéchalo.</p>
      </br>
      <p><strong>Te aconsejamos no guardar y borrar este correo para que un atacante no pueda tener acceso a la aplicación y
      recuerda no guardar tus contraseñas en lugares donde atacantes puedan acceder,
       como por ejemplo el gestor de contraseñas del navegador</strong></p>`, // html body
    }

    await this.sendMail(mailContent);

    delete newBusinessOwner.dataValues.user.dataValues.password;
    return newBusinessOwner;
  }

  async find() {
    const bota = await models.BusinessOwner.findAll({
      include: ['user']
    });

    const businessOwners = bota.map((businessOwner) => {
      businessOwner.dataValues.user = Object.fromEntries(Object.entries(businessOwner.dataValues.user.dataValues).filter(([key]) => key !== 'password'));

      return businessOwner;
    });

    return businessOwners;
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
    return { message: `mail sent to ${infoMail.to}` };
  }

}

module.exports = BusinessOwnerService;