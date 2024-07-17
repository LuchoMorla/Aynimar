const { config } = require("../config/config");
const nodemailer = require('nodemailer');

class ProposalService {
  constructor() {
  }

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

  async sendProposal(email, name, proposal) {
    const mail = {
      from: config.smtpMail, // sender address
      to: config.proposalEmailRmail || config.smtpMail, // list of receivers
      subject: `Propuesta enviada por ${name}`, // Subject line
      html: `<p>${name} con correo "${email}" ha enviado una propuesta.</p>
        <br />
        <p>La propuesta fue la siguiente: ${proposal}</p>`, // html body
    }
    const rta = await this.sendMail(mail);
    return rta;
  }

}

module.exports = { ProposalService }