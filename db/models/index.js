const { User, UserSchema } = require('./userModel');
const { Customer, CustomerSchema } = require('./customerModel');
const { Category, CategorySchema } = require('./categoryModel');
const { Product, ProductSchema } = require('./productModel');
const { Order, OrderSchema } = require('./orderModel');
const { OrderProduct, OrderProductSchema } = require('./order-productModel');
const { PaymentWaste, PaymentWasteSchema } = require('./payment-wasteModel');
const { Payment, PaymentSchema } = require('./paymentModel');
const { Recycler, RecyclerSchema } = require('./recyclerModel');
const { Waste, WasteSchema } = require('./wasteModel');
const { WasteCategory, WasteCategorySchema } = require('./wasteCategoryModel');
const { Wallet, WalletSchema } = require('./walletModel');
const { BusinessOwner, BussinesOwnerSchema } = require('./businessOwnerModel');
const { Business, BusinessSchema } = require('./businessModel');

const { Debit, DebitSchema } = require('./debitModel');


function setupModels(sequelize) {
  User.init(UserSchema, User.config(sequelize));
  Customer.init(CustomerSchema, Customer.config(sequelize));
  Category.init(CategorySchema, Category.config(sequelize));
  Product.init(ProductSchema, Product.config(sequelize));
  Order.init(OrderSchema, Order.config(sequelize));
  OrderProduct.init(OrderProductSchema, OrderProduct.config(sequelize));
  Recycler.init(RecyclerSchema, Recycler.config(sequelize));
  WasteCategory.init(WasteCategorySchema, WasteCategory.config(sequelize));
  Waste.init(WasteSchema, Waste.config(sequelize));
  Payment.init(PaymentSchema, Payment.config(sequelize));
  PaymentWaste.init(PaymentWasteSchema, PaymentWaste.config(sequelize));
  Wallet.init(WalletSchema, Wallet.config(sequelize));
  BusinessOwner.init(BussinesOwnerSchema, BusinessOwner.config(sequelize));
  Business.init(BusinessSchema, Business.config(sequelize));
  Debit.init(DebitSchema, Debit.config(sequelize));

  User.associate(sequelize.models);
  Customer.associate(sequelize.models);
  Category.associate(sequelize.models);
  Product.associate(sequelize.models);
  Order.associate(sequelize.models);
  Recycler.associate(sequelize.models);
  WasteCategory.associate(sequelize.models);
  Waste.associate(sequelize.models);
  Payment.associate(sequelize.models);
  Wallet.associate(sequelize.models);
  BusinessOwner.associate(sequelize.models);
  Business.associate(sequelize.models);

  Debit.associate(sequelize.models);
}

module.exports = setupModels;