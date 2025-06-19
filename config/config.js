/* require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'dev',
  isProd: process.env.NODE_ENV === 'production',
  port: process.env.PORT || 6969,
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  dbHost: process.env.DB_HOST,
  dbName: process.env.DB_NAME,
  dbPort: process.env.DB_PORT,
  apiKey: process.env.API_KEY,
  jwtSecret: process.env.JWT_KEY,
  temporalyJwtSecret: process.env.TEMPORALY_JWT_KEY,
  smtpMailKey: process.env.GPASS,
  smtpMail: process.env.SMAIL,
  receivermail: process.env.RMAIL,
  dbUrl: process.env.DATABASE_URL,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
  accessToken: process.env.ACCESS_TOKEN,
  refreshToken: process.env.REFRESH_TOKEN,
  proposalEmailRmail: process.env.PROPOSAL_EMAIL_RMAIL,
}

module.exports = { config };
 */
require('dotenv').config();

const dbUser = encodeURIComponent(process.env.DB_USER);
const dbPassword = encodeURIComponent(process.env.DB_PASSWORD);
const dbHost = process.env.DB_HOST;
const dbName = process.env.DB_NAME;
const dbPort = process.env.DB_PORT || 5432;

const dbUrl =
  process.env.DATABASE_URL ||
  `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

const config = {
  env: process.env.NODE_ENV || 'dev',
  isProd: process.env.NODE_ENV === 'production',
  port: process.env.PORT || 6969,
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  dbHost: process.env.DB_HOST,
  dbName: process.env.DB_NAME,
  dbPort: process.env.DB_PORT,
  dbUrl, // 👈 aquí se usa la URL construida
  apiKey: process.env.API_KEY,
  jwtSecret: process.env.JWT_KEY,
  temporalyJwtSecret: process.env.TEMPORALY_JWT_KEY,
  smtpMailKey: process.env.GPASS,
  smtpMail: process.env.SMAIL,
  receivermail: process.env.RMAIL,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
  accessToken: process.env.ACCESS_TOKEN,
  refreshToken: process.env.REFRESH_TOKEN,
  proposalEmailRmail: process.env.PROPOSAL_EMAIL_RMAIL,
};

module.exports = { config };
