'use strict';

const { models } = require('../../libs/sequelize');

const DROPI_TOKEN_KEY = 'dropi_session_token';

async function getTokenFromDB() {
  const row = await models.AppSetting.findOne({ where: { key: DROPI_TOKEN_KEY } });
  return row?.value ?? null;
}

async function saveTokenToDB(token) {
  await models.AppSetting.upsert({
    key:       DROPI_TOKEN_KEY,
    value:     token,
    updatedAt: new Date(),
  });
}

module.exports = { getTokenFromDB, saveTokenToDB };
