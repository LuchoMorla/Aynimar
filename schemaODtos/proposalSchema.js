const Joi = require("joi");

// Formulario público: longitudes acotadas (auditoría ayni-play/03).
const sendProposalSchema = Joi.object({
  email: Joi.string().email().max(254).required(),
  name: Joi.string().trim().max(100).required(),
  proposal: Joi.string().trim().max(5000).required(),
});


module.exports = {
  sendProposalSchema
}
