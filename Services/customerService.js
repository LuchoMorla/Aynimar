const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const { models } = require('../libs/sequelize');

const { config } = require('./../config/config');
// const https = require('https');
const sendMail = require('./../utils/sendMail')

const jwt = require('jsonwebtoken');

const AuthService = require('./authService');
const UserService = require('./userServices');
const authService = new AuthService();
const userService = new UserService();


// const nodemailer = require('nodemailer');

class CustomerService {

  constructor() { }

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

    // await this.sendMail(mailContent);
    try {
      await sendMail(mailContent);
      console.log('Welcome email sent successfully via Brevo');
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // No lanzar el error para que no rompa la creación del usuario
    }

    delete newCustomer.dataValues.user.dataValues.password;
    // --- INICIO DE LA MODIFICACIÓN ---
    // Usamos el AuthService existente para generar el token y la estructura de respuesta.
    // La función signToken ya nos devuelve un objeto { user, token }.
    const authResponse = authService.signToken(user);
    
    // Devolvemos una estructura que contiene los datos del cliente y la respuesta de autenticación.
    return { 
      customer: newCustomer,
      auth: authResponse // Esto contendrá { user: ..., token: ... }
    };
    // --- FIN DE LA MODIFICACIÓN ---
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
  
   

}

module.exports = CustomerService;
