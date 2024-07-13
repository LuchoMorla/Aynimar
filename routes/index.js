const express = require('express');

const productosRouting = require('./productosRouting');
const categoriasRouting = require('./categoriasRouting');
const usersRuta = require('./usersRouting');
const orderRouter = require('./orderRouter');
const customersRouter = require('./customersRouting');
const authRouter = require('./authRouter');
const profileRouter = require('./profileRouter');
const wasteRouter = require('./wasteRouter');
const recyclerRouter = require('./recyclerRouter');

const debitRouter = require('./debitRouter');

const paymentRouter = require('./paymentRouter');
const wasteCategoryRouter = require('./wasteCategoriesRouting');
const walletRouter = require('./walletRouter');
const mailRouter = require('./contactRouter');
const businessRouter = require('./businessRouter');
const businessOwnerRouter = require('./businessOwnerRouter');
const filesRouting = require('./filesRouting');
const offersRouter = require('./offersRouting');

function routerApi(app) {
    app.use('/products', productosRouting);
    app.use('/category', categoriasRouting);
    app.use('/users', usersRuta);

    const routerV1 = express.Router();
    app.use('/api/v1', routerV1);

    routerV1.use("/files", filesRouting);
    routerV1.use('/products', productosRouting);
    routerV1.use('/categories', categoriasRouting);
    routerV1.use('/users', usersRuta);
    routerV1.use('/orders', orderRouter);
    routerV1.use('/customers', customersRouter);
    routerV1.use('/auth', authRouter);
    routerV1.use('/profile', profileRouter);
    routerV1.use('/wastes', wasteRouter);
    routerV1.use('/recyclers', recyclerRouter);
    routerV1.use('/payments', paymentRouter);
    routerV1.use('/waste-categories', wasteCategoryRouter);
    routerV1.use('/wallets', walletRouter);
    routerV1.use('/mail', mailRouter);
    routerV1.use('/debits', debitRouter);
    routerV1.use('/debits', debitRouter);
    routerV1.use('/business', businessRouter);
    routerV1.use('/business-owner', businessOwnerRouter);
    routerV1.use('/offers', offersRouter);
}

module.exports = routerApi;