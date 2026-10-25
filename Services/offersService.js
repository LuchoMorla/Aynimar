const boom = require('@hapi/boom');
const sequelize = require('../libs/sequelize');

const { models } = sequelize;

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

  // IDOR (auditoría R4): admin, cualquier oferta; business_owner, solo las
  // ofertas cuyo pago incluye un residuo de un negocio suyo. Si no → 404.
  async findOneForUser(id, { sub, role }) {
    const offer = await this.findOne(id);
    if (!offer) throw boom.notFound('Offer not found');
    if (role === 'admin') return offer;
    const [rows] = await sequelize.query(
      `SELECT 1 FROM payments_wastes pw
         JOIN wastes w           ON w.id  = pw.waste_id
         JOIN business b         ON b.id  = w.business_id
         JOIN bussiness_owner bo ON bo.id = b.business_owner_id
        WHERE pw.payment_id = :paymentId AND bo.user_id = :userId
        LIMIT 1`,
      { replacements: { paymentId: offer.paymentId, userId: sub } }
    );
    if (!rows.length) throw boom.notFound('Offer not found');
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
    if (!offer) throw boom.notFound('Offer not found');
    const paymentWaste = await models.PaymentWaste.findOne({
      where: {
        paymentId: offer.paymentId
      }
    });

    if (paymentWaste) await paymentWaste.destroy();
    await offer.destroy();

    return offer;
  }
}

module.exports = OffersService;