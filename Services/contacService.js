const nodemailer = require('nodemailer');
const boom = require('@hapi/boom');
const bcrypt = require('bcrypt');
const { config } = require('./../config/config');

class ContactService {
    constructor(){}

    async contact(data) {

    const mailContact = {
      from: config.smtpMail, // sender address
      to: `${config.receivermail}, ${config.smtpMail}`, // list of receivers
      subject: `Contacto`, // Subject line
      html: `<p> un cliente con se contacto desde la aplicacion Aynimar</p>
      </br>
      <p>su nombre: ${data.name}</p>
      <p>mail: ${data.email} </p>
      <br>
      <p>mensaje: ${data.message}</p>
      </br>
      `, // html body
    };
      
     await this.sendMail(mailContact);
    };

    //servicio de Contacto para maquinas expendedoras aynimar
    async vendingMailContact(data) {
      const mailContact = {
        from: config.smtpMail, // sender address
        to: `${config.receivermail}, ${config.smtpMail}`, // list of receivers
        subject: `Contacto Cliente Maquina Expendedora`, // Subject line
        html: `<p>Un valioso cliente de una maquina expendedora se contacto desde la aplicacion Aynimar</p>
        </br>
        <p>su nombre: ${data.name}</p>
        <p>mail: ${data.email} </p>
        <p>ubicacion: ${data.ubicacion}</p>
        <p>celular | whatsapp: ${data.celu} </p>
        <br>
        <p>mensaje: ${data.message}</p>
        </br>
        `, // html body
      };
        
       await this.sendMail(mailContact);
    };

    async vendingProspectMailContact(data) {
      const mailContact = {
        from: config.smtpMail, // sender address
        to: `${config.receivermail}, ${config.smtpMail}`, // list of receivers
        subject: `Prospecto de negocio para Maquina Expendedora`, // Subject line
        html: `<p>Un potencial socio de maquinas expendedoras se contacto desde la aplicacion Aynimar</p>
        </br>
        <p>su nombre: ${data.name}</p>
        <p>mail: ${data.email} </p>
        <p>ubicacion: ${data.ubicacion}</p>
        <p>celular | whatsapp: ${data.celu} </p>
        <br>
        <p>mensaje: ${data.message}</p>
        </br>
        `, // html body
      };
        
       await this.sendMail(mailContact);
    }

    //send Mail
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
};

module.exports = ContactService;