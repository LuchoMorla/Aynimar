const boom = require('@hapi/boom');
const { models } = require('../libs/sequelize');

class OffersService {

  async create(data) {
    const newOffer = await models.Offers.create(data, {
      include: ["payment"]
    });
    return newOffer;
  }

  async find() {
    const offers = await models.Offers.findAll({
      include: ["payment"]
    });

    return offers;
  }

  async findOne(id) {
    const offer = await models.Offers.findByPk(id, {
      include: [{
        association: "payment",
        include: ["commodities", {
          association: "recycler",
          include: [{
            association: "user",
            attributes: {
              include: ["email"]
            }
          }]
        }]
      }]
    });

    return offer;
  }

  async findBusiness(businessId) {
    const offers = await models.Offers.findAll({
      include: [{
        association: "payment",
        include: [{
          association: "commodities",
          where: {
            businessId,
          }
        }, {
          association: "recycler",
          include: [{
            association: "user",
            attributes: {
              exclude: ["password", "recoveryToken"]
            }
          }]
        }],
      }],
    });
    return offers;
  }

  async update(id, data) {
    const offer = await models.Offers.findByPk(id);
    if (!offer) {
      throw boom.notFound('Offer not found');
    }
    const updatedOffer = await offer.update(data);

    return updatedOffer;
  }

  async delete(id) {
    const offer = await models.Offers.findByPk(id);
    const paymentWaste = await models.PaymentWaste.findOne({
      where: {
        paymentId: offer.paymentId
      }
    });

    await paymentWaste.destroy();
    await offer.destroy();

    return offer;
  }
}

module.exports = OffersService;