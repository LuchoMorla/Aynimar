'use strict';

const { models } = require('../../libs/sequelize');

const DROPI_TOKEN_KEY      = 'dropi_session_token';
const DROPI_2FA_STATUS_KEY = 'dropi_2fa_status';

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

async function get2FAStatus() {
  const row = await models.AppSetting.findOne({ where: { key: DROPI_2FA_STATUS_KEY } });
  return row?.value ?? null;
}

async function set2FAStatus(status) {
  await models.AppSetting.upsert({
    key:       DROPI_2FA_STATUS_KEY,
    value:     status ?? '',
    updatedAt: new Date(),
  });
}

module.exports = { getTokenFromDB, saveTokenToDB, get2FAStatus, set2FAStatus };
