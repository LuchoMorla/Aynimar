const { Pool } = require('pg');

const { config } = require('./../config/config');

const options = {};

if (config.isProd) {
    options.connectionString = config.dbUrl;
    options.ssl = {
        rejectUnauthorized: false
    }
} else {
    const USER = encodeURIComponent(config.dbUser);
    const PASSWORD = encodeURIComponent(config.dbPassword);
    const HOST = encodeURIComponent(config.dbHost);
    const DATABASE = encodeURIComponent(config.dbName);
    const PORT = encodeURIComponent(config.dbPort);
    const URI = `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`;
    options.connectionString = URI;
}

const pool = new Pool(options);

module.exports = pool;