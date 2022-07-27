const { config } = require('../config/config');

/* const USER = encodeURIComponent(config.dbUser);
const PASSWORD = encodeURIComponent(config.dbPassword);
const HOST = encodeURIComponent(config.dbHost);
const DATABASE = encodeURIComponent(config.dbName);
const PORT = encodeURIComponent(config.dbPort);
const URI = `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`; */

module.exports = {
    development: {
        url: config.dbUrl,
        dialect: 'postgres',
    },
    production: {
        url: config.dbUrl,
        dialect: 'postgres',
        ssl: {
            rejectUnauthorized: false
        }
    }
}