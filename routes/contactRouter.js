const express = require('express');
const { postEmail, vendingPostEmail } = require('../schemaODtos/mailSchema');
const router = express.Router();
const validatorHandler = require('./../middlewares/validatorHandler');
const ContactService = require('./../Services/contacService'),
service = new ContactService();

router.post(
    '/contact',
    validatorHandler(postEmail, 'body'),
    async (req, res, next) => {
      try {
        const mail = req.body;
        res.status(201).json(await service.contact(mail));
      } catch (error) {
        next(error);
      }
    }
  );

router.post(
    '/vendingContact',
    validatorHandler(vendingPostEmail, 'body'),
    async (req, res, next) => {
      try {
        const mail = req.body;
        res.status(201).json(await service.vendingMailContact(mail));
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/vendingProspectContact',
    validatorHandler(vendingPostEmail, 'body'),
    async (req, res, next) => {
      try {
        const mail = req.body;
        res.status(201).json(await service.vendingProspectMailContact(mail));
      } catch (error) {
        next(error);
      }
    }
  );

module.exports = router;