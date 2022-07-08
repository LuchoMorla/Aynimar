const express = require('express');

const productosRouting = require('./productosRouting');
const categoriasRouting = require('./categoriasRouting');
const usersRuta = require('./usersRouting');
const orderRouter = require('./orderRouter');
const customersRouter = require('./customersRouting');
const authRouter = require('./authRouter');
const profileRouter = require('./profileRouter');


function routerApi(app) {
    app.use('/products', productosRouting);
    app.use('/category', categoriasRouting);
    app.use('/users', usersRuta);

    const routerV1 = express.Router();
    app.use('/api/v1', routerV1);

    routerV1.use('/products', productosRouting);
    routerV1.use('/categories', categoriasRouting);
    routerV1.use('/users', usersRuta);
    routerV1.use('/orders', orderRouter);
    routerV1.use('/customers', customersRouter);
    routerV1.use('/auth', authRouter);
    routerV1.use('/profile', profileRouter);
}

module.exports = routerApi;
