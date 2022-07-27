const { Pool } = require('pg');

const { config } = require('./../config/config');

let URI = '';

if (config.isProd) {
    URI = config.dbUrl;
} else {
    const USER = encodeURIComponent(config.dbUser);
    const PASSWORD = encodeURIComponent(config.dbPassword);
    const HOST = encodeURIComponent(config.dbHost);
    const DATABASE = encodeURIComponent(config.dbName);
    const PORT = encodeURIComponent(config.dbPort);
    URI = `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`;
}

    const pool = new Pool({ connectionString: URI});

module.exports = pool;