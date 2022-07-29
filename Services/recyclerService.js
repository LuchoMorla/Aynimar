const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const { models } = require('../libs/sequelize');
const { config } = require('./../config/config');

const nodemailer = require('nodemailer');

class RecyclerService {

  constructor() {}

  async find() {
    const rta = await models.Recycler.findAll({
      include: ['user']
    });
    for (var i = 0; i < rta.length; i++) {
      delete rta[i].dataValues.user.dataValues.password;
    }
    return rta;
  }

  async findOne(id) {
    const user = await models.Recycler.findByPk(id);
    if (!user) {
      throw boom.notFound('Recycler not found');
    }
    return user;
  }

  async findByUserId(userId) {
    const recycler = await models.Recycler.findOne({
      where: { 'user_id': userId }/* ,
      include: ['user']  comente esto por que no lo ocupo y deja a la fuga informacion importante */
    });
/*    lo saque para que funcione como un metodo tipo middleware
     if (!recycler) {
      throw boom.notFound('Recycler not found');
    } */
    return recycler;
  }

  async create(data) {
    const mailPassword = data.user.password;
    const hash = await bcrypt.hash(data.user.password, 10);
    const role = 'recycler';
    const newData = {
      ...data,
      user: {
        ...data.user,
        password: hash,
        role: role
      }
    }
    const newRecycler = await models.Recycler.create(newData, {
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

    delete newRecycler.dataValues.user.dataValues.password;
    return newRecycler;
  }

  async createRecyclerByCustomer(data) {
    const customerRecycler = await models.Recycler.create({
      name: data.dataValues.name,
      lastName: data.dataValues.lastName,
      phone: data.dataValues.phone,
      userId: data.dataValues.userId
    });
    return customerRecycler;
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

    //Other services to recyclers
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

module.exports = RecyclerService;