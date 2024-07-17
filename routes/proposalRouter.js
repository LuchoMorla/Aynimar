const express = require('express');
const validatorHandler = require('../middlewares/validatorHandler');
const { sendProposalSchema } = require('../schemaODtos/proposalSchema');
const { ProposalService } = require('../Services/proposalService');

const router = express.Router();
const service = new ProposalService();

router.post('/',
  validatorHandler(sendProposalSchema, 'body'),
  async (req, res, next) => {
    try {
      const body = req.body;
      const proposal = await service.sendProposal(body.email, body.name, body.proposal);
      res.json(proposal);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;