'use strict';

/**
 * Seguimiento visual del pedido: etapas derivadas SOLO de datos reales de la orden
 * (state_order, fulfillment_status, dropi_order_id, tracking_number y el registro
 * de eventos dropi_status_history). Nunca simula avances: una etapa sin evento
 * fechado pero implícita en el estado sale done=true con at=null.
 * Contrato: ops-ceo-cto/informes/seguimiento-pedido-contrato.md.
 */

const STAGES = [
  { key: 'confirmed', label: 'Pedido confirmado' },
  { key: 'validated', label: 'Pedido validado' },
  { key: 'sent_to_provider', label: 'Enviado al proveedor' },
  { key: 'dispatched', label: 'Despachado (guía generada)' },
  { key: 'in_transit', label: 'En camino' },
  { key: 'delivered', label: 'Entregado' },
];

const BRANCH_LABELS = {
  rejected: 'Rechazado en la entrega',
  returned: 'Devuelto',
  cancelled: 'Cancelado',
  exception: 'En revisión por nuestro equipo',
};

// Etapa mínima alcanzada según state_order (pedidos sin eventos, p. ej. gestionados a mano).
const STATE_RANK = { en_preparacion: 3, enviado: 4, en_transito: 4, entregado: 5, por_devolver: 4, devuelto: 4 };
// fulfillment_status que implican "validado".
const VALIDATED_FS = ['AWAITING_CONFIRMATION', 'CONFIRMED', 'SENDING', 'DISPATCH_UNKNOWN', 'DISPATCHED', 'MANUAL_DISPATCH'];
// fulfillment_status que significan "detenido para revisión humana".
const EXCEPTION_FS = ['BLOCKED', 'DISPATCH_UNKNOWN', 'FAILED_DROPI_FULFILLMENT'];

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** @returns {{status, currentStage, stages, branch, trackingNumber, carrierName, lastEventAt}} */
function buildProgress(order) {
  const h = Array.isArray(order.dropiStatusHistory) ? order.dropiStatusHistory : [];
  const first = (pred) => h.find(pred)?.at ?? null;
  const confirmed = order.state && order.state !== 'carrito';

  const at = {
    confirmed: confirmed ? iso(order.confirmedAt) : null,
    validated: first((e) => e.group === 'validated'),
    sent_to_provider: first((e) => e.status === 'ENVIADO_A_DROPI'),
    dispatched: first((e) => e.guide === true), // solo con guía registrada; si no, at=null
    in_transit: first((e) => e.group === 'transit'),
    delivered: first((e) => e.group === 'delivered'),
  };

  // Índice de la última etapa alcanzada (-1 = ninguna).
  let reached = -1;
  if (confirmed) reached = 0;
  if (at.validated || VALIDATED_FS.includes(order.fulfillmentStatus)) reached = 1;
  if (order.dropiOrderId || at.sent_to_provider) reached = 2;
  if (order.trackingNumber || at.dispatched) reached = 3;
  if (at.in_transit) reached = 4;
  if (at.delivered) reached = 5;
  reached = Math.max(reached, STATE_RANK[order.stateOrder] ?? -1);

  const lastGroup = [...h].reverse().find((e) => e.group && !['validated', 'dispatched'].includes(e.group))?.group;
  let branch = null;
  if (order.stateOrder === 'cancelado') {
    const rejected = lastGroup === 'rejected';
    branch = { key: rejected ? 'rejected' : 'cancelled', at: rejected ? first((e) => e.group === 'rejected') : null };
  } else if (['por_devolver', 'devuelto'].includes(order.stateOrder)) {
    branch = { key: 'returned', at: first((e) => e.group === 'returning' || e.group === 'returned') };
  } else if (order.stateOrder !== 'entregado' && (EXCEPTION_FS.includes(order.fulfillmentStatus) || lastGroup === 'issue')) {
    branch = { key: 'exception', at: null };
  }
  if (branch) branch.label = BRANCH_LABELS[branch.key];

  const stages = STAGES.map((s, i) => ({ ...s, done: i <= reached, at: i <= reached ? at[s.key] : null }));
  let status = 'in_progress';
  if (branch) status = branch.key;
  else if (reached === 5) status = 'delivered';
  else if (!confirmed) status = 'cart';

  return {
    status,
    currentStage: reached >= 0 ? STAGES[reached].key : null,
    stages,
    branch,
    trackingNumber: reached >= 3 ? order.trackingNumber ?? null : null,
    carrierName: reached >= 3 ? order.carrierName ?? null : null,
    lastEventAt: h.length ? h[h.length - 1].at : at.confirmed,
  };
}

module.exports = { buildProgress, STAGES };
