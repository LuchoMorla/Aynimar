const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
// const nodemailer = require('nodemailer');

const { config } = require('./../config/config');
const UserService = require('./userServices');
const sendMail = require('./../utils/sendMail')

const service = new UserService();

class AuthService {

  async getUser(email, password) {
    const user = await service.findByEmail(email);
    if (!user) {
      throw boom.unauthorized();
    }
    const isMatch = await bcrypt.compare(password, user.password);
    // const isMatch = true;
    if (!isMatch) {
      throw boom.unauthorized();
    }
    delete user.dataValues.password;
    delete user.dataValues.recoveryToken;
    return user;
  }

  async getProfile({ sub }) {
    const user = await service.findOne(sub);
    delete user.dataValues.password;
    delete user.dataValues.recoveryToken;
    return user;
  }

  signToken(user) {
    const payload = {
      sub: user.id,
      role: user.role
    }
    const token = jwt.sign(payload, config.jwtSecret);
    return {
      user,
      token
    };
  }

  async sendRecovery(email) {
    const user = await service.findByEmail(email);
    if (!user) {
      throw boom.unauthorized();
    }
    const payload = { sub: user.id };
    const token = jwt.sign(payload, config.temporalyJwtSecret, { expiresIn: '15min' });
    const link = `https://aynimar.com/recovery?token=${token}`;
    await service.update(user.id, { recoveryToken: token });
    const mail = {
      from: config.smtpMail, // sender address
      to: `${user.email}`, // list of receivers
      subject: "Recuperacion de contraseña", // Subject line
      /*         text: "Hola santi", // plain text body   lo comente por que vamos a enviar solamente el html*/
      html: `<p>Has pedido un cambio de contraseña. </p>
        <p>Para cambiar tu contraseña haz click <a href='${link}'>aquí</a> o ingresa al siguiente link para recuperar tu contraseña: =><b> ${link} </b></p><p>Este link expirara en 15 minutos, te recomendamos que lo hagas dentro del tiempo estimado para
        que puedas generar una nueva contraseña. </p>`, // html body
    }
    // const rta = await this.sendMail(mail);
    // await this.sendMail(mailContent);
        try {
          var rta =   await sendMail(mail);
          console.log('Welcome email sent successfully via Brevo');
        } catch (emailError) {
          var rta =   emailError;
          console.error('Failed to send welcome email:', emailError);
        }

    return rta;
  }

  

  async changePassword(token, newPassword) {
    try {
      const payload = jwt.verify(token, config.temporalyJwtSecret);
      const user = await service.findOne(payload.sub);
      if (user.recoveryToken !== token) {
        throw boom.unauthorized();
      }
      const hash = await bcrypt.hash(newPassword, 10);
      await service.update(user.id, { recoveryToken: null, password: hash });
      const newToken = this.signToken(user);
      return newToken;
    } catch (error) {
      throw boom.unauthorized();
    }
  }

  async autoLogin(token) {
    try {
      const payload = jwt.verify(token, config.temporalyJwtSecret);
      const user = await service.findOne(payload.sub);
      if (user.recoveryToken !== token) {
        throw boom.unauthorized();
      }
      await service.update(user.id, { recoveryToken: 'verified' });
      const newToken = this.signToken(user);
      return newToken;
    } catch (error) {
      throw boom.unauthorized();
    }
  }
}

module.exports = AuthService;
