const { config } = require("../config/config");
const sendMailResend = require('../utils/sendMailResend');

class ProposalService {
  constructor() {
  }

  async sendMail(infoMail) {
    return sendMailResend(infoMail);
  }

  async sendProposal(email, name, proposal) {
    const mail = {
      from: config.smtpMail, // sender address
      to: config.receivermail || config.smtpMail, // list of receivers
      subject: `Propuesta enviada por ${name}`, // Subject line
      html: `<p>${name} con correo "${email}" ha enviado una propuesta.</p>
        <p>La propuesta fue la siguiente: ${proposal}</p>`, // html body
    }

    const mailConfirmation = {
      from: config.smtpMail, // sender address
      to: `${email}`, // list of receivers
      subject: `Confirmación de propuesta a Aynimar`, // Subject line
      html: `<p>¡Hola, ${name}!.</p>
        <p>Tu propuesta ha sido recibida por el equipo, muchas gracias por su recomendación a nuestra plataforma.</p>`, // html body
    }

    const rta = await this.sendMail(mail);
    const rtaConfirmation = await this.sendMail(mailConfirmation);
    return {
      rta,
      rtaConfirmation
    };
  }

}

module.exports = { ProposalService }