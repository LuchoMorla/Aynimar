const Joi = require("joi");

const sendProposalSchema = Joi.object({
  email: Joi.string().email().required(),
  name: Joi.string(),
  proposal: Joi.string(),
});


module.exports = {
  sendProposalSchema
}