'use strict';
/**
 * F2 — revisión de piezas creativas desde Telegram (ver docs/TELEGRAM_SECURITY.md).
 * "Aprobar" NO publica en redes: deja la pieza aprobada y el router envía el
 * kit de publicación manual. Sin datos de clientes.
 */
const { models } = require('../libs/sequelize');

const ACTION_STATUS = { ap: 'approved', rj: 'rejected', ch: 'changes_requested' };
const STATUS_LABEL = {
  pending: '⏳ Pendiente',
  approved: '✅ Aprobado',
  rejected: '❌ Rechazado',
  changes_requested: '✏️ Cambios solicitados',
};
const SOCIAL_KEY = 'social.enabled';

function recordPending({ ref, productId, variant, network, utmLink, caption, telegramFileId, telegramMessageId, productionCostUsd = null }) {
  return models.CreativeReview.create({ ref, productId, variant, network, utmLink, caption, telegramFileId, telegramMessageId, productionCostUsd, status: 'pending' });
}

/**
 * Transición atómica pending → estado de la acción (UPDATE ... WHERE status='pending').
 * @returns {{ changed: boolean, review: object|null }} review = fila actual (null si no existe)
 */
async function decide(ref, action, adminId) {
  const status = ACTION_STATUS[action];
  if (!status) throw new Error(`acción desconocida: ${action}`);
  const [count] = await models.CreativeReview.update(
    { status, decidedAt: new Date(), decidedBy: adminId },
    { where: { ref, status: 'pending' } }
  );
  const review = await models.CreativeReview.findByPk(ref);
  return { changed: count === 1, review };
}

/** Guarda el texto de cambios solo si la pieza está en changes_requested. */
async function saveChangeRequest(ref, text) {
  const [count] = await models.CreativeReview.update(
    { changeRequest: String(text).slice(0, 2000) },
    { where: { ref, status: 'changes_requested' } }
  );
  return count === 1;
}

function latest(limit = 10) {
  return models.CreativeReview.findAll({ order: [['createdAt', 'DESC']], limit });
}

async function isSocialEnabled() {
  const row = await models.AppSetting.findOne({ where: { key: SOCIAL_KEY } });
  return row?.value === 'true';
}

function setSocialEnabled(enabled) {
  return models.AppSetting.upsert({ key: SOCIAL_KEY, value: enabled ? 'true' : 'false', updatedAt: new Date() });
}

module.exports = { recordPending, decide, saveChangeRequest, latest, isSocialEnabled, setSocialEnabled, ACTION_STATUS, STATUS_LABEL, SOCIAL_KEY };
