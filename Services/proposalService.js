const { config } = require("../config/config");
const sendMailResend = require('../utils/sendMailResend');

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class ProposalService {
  constructor() {
  }

  async sendMail(infoMail) {
    return sendMailResend(infoMail);
  }

  // Seguridad (auditoría ayni-play/03): el destinatario es solo el buzón interno
  // del servidor. Ya no se envía confirmación al `email` del formulario (público:
  // permitía usar el remitente de Aynimar para enviar correo a cualquiera).
  async sendProposal(email, name, proposal) {
    const mail = {
      from: config.smtpMail, // sender address
      to: config.receivermail || config.smtpMail, // list of receivers
      subject: `Propuesta enviada por ${String(name).replace(/[\r\n]+/g, ' ')}`, // Subject line (texto plano)
      html: `<p>${esc(name)} con correo "${esc(email)}" ha enviado una propuesta.</p>
        <p>La propuesta fue la siguiente: ${esc(proposal)}</p>`, // html body
    }

    const rta = await this.sendMail(mail);
    return {
      rta,
      rtaConfirmation: null,
    };
  }

}

module.exports = { ProposalService }
