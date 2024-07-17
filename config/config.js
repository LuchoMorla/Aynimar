require('dotenv').config();

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
