'use strict';
/* eslint-disable no-console */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LIMPIEZA DE ÓRDENES DE PRUEBA — Aynimar
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Borra órdenes de venta y TODAS sus filas hijas en una sola transacción.
 * Nace de un bug de esquema: `debits.order_id` es NOT NULL con
 * `ON DELETE SET NULL` (contradicción) → Postgres RECHAZA borrar cualquier
 * orden que tenga un `debit` asociado. El botón "Eliminar orden" del dashboard
 * traga ese error y sólo muestra "No se puede eliminar la orden".
 *
 * Este script elimina explícitamente los hijos en el orden correcto y luego la
 * orden, evitando el constraint roto sin tocar el esquema.
 *
 * Por DEFECTO es DRY RUN: sólo lee y reporta. No borra nada sin `--delete` +
 * `--confirm` con el texto exacto.
 *
 * TABLAS QUE TOCA (sólo las que existan en la BD):
 *   debits            (order_id)              → DELETE
 *   payment_proofs    (order_id, CASCADE)     → DELETE explícito
 *   orders_products   (order_id, SET NULL)    → DELETE (si no, quedan huérfanas)
 *   wallet_transactions (reference_type='order') → DELETE (historial Ayni-Créditos de prueba)
 *   orders                                    → DELETE
 *
 * USO
 *   node scripts/orders-cleanup.js                       # DRY RUN — todas las órdenes
 *   node scripts/orders-cleanup.js --business 8          # sólo órdenes con ≥1 item del negocio 8
 *   node scripts/orders-cleanup.js --ids 12,13,14        # sólo esos ids
 *   node scripts/orders-cleanup.js --json                # vuelca el detalle por orden
 *
 *   # BORRADO — requiere TODO:
 *   node scripts/orders-cleanup.js --delete \
 *        --confirm "BORRAR <N> ORDENES DE PRODUCCION" \
 *        [--business 8] [--ids ...] [--max 500]
 *
 * En Railway:
 *   railway run --service Aynimar node scripts/orders-cleanup.js            # dry run
 *   railway run --service Aynimar node scripts/orders-cleanup.js --delete --confirm "BORRAR N ORDENES DE PRODUCCION"
 *
 * BD: usa DATABASE_URL / config, igual que la app (libs/sequelize).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const sequelize = require('../libs/sequelize');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}

const DO_DELETE   = flag('delete');
const CONFIRM     = opt('confirm');
const BUSINESS_ID = opt('business') ? parseInt(opt('business'), 10) : null;
const ONLY_IDS    = opt('ids') ? opt('ids').split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite) : null;
const MAX         = parseInt(opt('max', '500'), 10);
const AS_JSON     = flag('json');

const CHILD_TABLES = ['debits', 'payment_proofs', 'orders_products', 'wallet_transactions'];

async function tableExists(name) {
  const [rows] = await sequelize.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = :name LIMIT 1`,
    { replacements: { name } }
  );
  return rows.length > 0;
}

async function main() {
  await sequelize.authenticate();

  // Which child tables actually exist (schema drift guard)
  const present = {};
  for (const t of ['orders', ...CHILD_TABLES]) present[t] = await tableExists(t);
  if (!present.orders) throw new Error('La tabla "orders" no existe en esta BD. Aborto.');

  // ── Build the target order-id set ──────────────────────────────────────────
  let where = '1=1';
  const repl = {};
  if (ONLY_IDS && ONLY_IDS.length) { where = 'o.id IN (:ids)'; repl.ids = ONLY_IDS; }
  else if (BUSINESS_ID != null) {
    where = `EXISTS (
      SELECT 1 FROM orders_products op
      JOIN products p ON p.id = op.product_id
      WHERE op.order_id = o.id AND p.business_id = :bid
    )`;
    repl.bid = BUSINESS_ID;
  }

  const [orders] = await sequelize.query(
    `SELECT o.id, o.state, o.state_order AS "stateOrder", o.payment_status AS "paymentStatus",
            o.total, o.created_at AS "createdAt", o.customer_id AS "customerId"
     FROM orders o
     WHERE ${where}
     ORDER BY o.id ASC`,
    { replacements: repl }
  );

  if (orders.length === 0) {
    console.log('No hay órdenes que coincidan con el filtro. Nada que hacer.');
    return;
  }

  const orderIds = orders.map((o) => o.id);

  // ── Count child rows per table ────────────────────────────────────────────
  const childCounts = {};
  for (const t of CHILD_TABLES) {
    if (!present[t]) { childCounts[t] = 'N/A (tabla no existe)'; continue; }
    let q;
    if (t === 'wallet_transactions') {
      q = `SELECT COUNT(*)::int AS n FROM wallet_transactions
           WHERE reference_type = 'order' AND reference_id IN (:ids)`;
    } else {
      q = `SELECT COUNT(*)::int AS n FROM ${t} WHERE order_id IN (:ids)`;
    }
    const [[row]] = await sequelize.query(q, { replacements: { ids: orderIds } });
    childCounts[t] = row.n;
  }

  // ── Enrich per-order detail ──────────────────────────────────────────────
  const [detail] = await sequelize.query(
    `SELECT o.id,
            (SELECT COUNT(*)::int FROM orders_products WHERE order_id = o.id) AS items,
            ${present.debits ? `(SELECT COUNT(*)::int FROM debits WHERE order_id = o.id)` : '0'} AS debits,
            ${present.payment_proofs ? `(SELECT COUNT(*)::int FROM payment_proofs WHERE order_id = o.id)` : '0'} AS proofs,
            ${present.wallet_transactions ? `(SELECT COUNT(*)::int FROM wallet_transactions WHERE reference_type='order' AND reference_id = o.id)` : '0'} AS wtx,
            c.id AS customer, u.email AS email
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE o.id IN (:ids)
     ORDER BY o.id ASC`,
    { replacements: { ids: orderIds } }
  );
  const detailById = Object.fromEntries(detail.map((d) => [d.id, d]));

  // ── Report ──────────────────────────────────────────────────────────────
  const totalSum = orders.reduce((s, o) => s + Number(o.total || 0), 0);
  const byState = {};
  orders.forEach((o) => { byState[o.state] = (byState[o.state] || 0) + 1; });

  console.log('\n══════════════ LIMPIEZA DE ÓRDENES — ' + (DO_DELETE ? 'MODO BORRADO' : 'DRY RUN') + ' ══════════════');
  console.log(`Filtro:            ${ONLY_IDS ? `ids=${ONLY_IDS.join(',')}` : BUSINESS_ID != null ? `business=${BUSINESS_ID}` : 'TODAS las órdenes'}`);
  console.log(`Órdenes a borrar:  ${orders.length}`);
  console.log(`Suma de "total":   ${totalSum.toFixed(2)}`);
  console.log(`Por state:         ${JSON.stringify(byState)}`);
  console.log(`Filas hijas:       ${JSON.stringify(childCounts)}`);
  console.log('');

  if (AS_JSON) {
    console.log(JSON.stringify(orders.map((o) => ({ ...o, ...detailById[o.id] })), null, 2));
  } else {
    console.log('  id   | state            | pay      | total   | items dbt prf wtx | cliente / email                | creada');
    console.log('  -----+------------------+----------+---------+-------------------+--------------------------------+---------------------');
    for (const o of orders) {
      const d = detailById[o.id] || {};
      console.log(
        `  ${String(o.id).padEnd(4)} | ${String(o.state || '').padEnd(16)} | ${String(o.paymentStatus || '-').padEnd(8)} | ` +
        `${String(Number(o.total || 0).toFixed(2)).padStart(7)} | ` +
        `${String(d.items ?? 0).padStart(5)} ${String(d.debits ?? 0).padStart(3)} ${String(d.proofs ?? 0).padStart(3)} ${String(d.wtx ?? 0).padStart(3)} | ` +
        `${String((d.email || (d.customer ? `customer#${d.customer}` : 'invitado')) || '').padEnd(30)} | ` +
        `${o.createdAt ? new Date(o.createdAt).toISOString().slice(0, 19) : '-'}`
      );
    }
  }
  console.log('');

  // ── DRY RUN ends here ───────────────────────────────────────────────────
  if (!DO_DELETE) {
    const expected = `BORRAR ${orders.length} ORDENES DE PRODUCCION`;
    console.log('DRY RUN — no se borró nada.');
    console.log(`Para ejecutar:\n  node scripts/orders-cleanup.js --delete --confirm "${expected}"` +
      (BUSINESS_ID != null ? ` --business ${BUSINESS_ID}` : '') +
      (ONLY_IDS ? ` --ids ${ONLY_IDS.join(',')}` : ''));
    return;
  }

  // ── DELETE ─────────────────────────────────────────────────────────────
  const expected = `BORRAR ${orders.length} ORDENES DE PRODUCCION`;
  if (CONFIRM !== expected) {
    throw new Error(`--confirm no coincide.\n  esperado: "${expected}"\n  recibido: "${CONFIRM || ''}"`);
  }
  if (orders.length > MAX) {
    throw new Error(`${orders.length} órdenes supera --max ${MAX}. Sube --max si es intencional.`);
  }

  console.log(`Borrando ${orders.length} órdenes en una transacción…`);
  const t = await sequelize.transaction();
  try {
    const deleted = {};
    if (present.debits) {
      const [, meta] = await sequelize.query(`DELETE FROM debits WHERE order_id IN (:ids)`,
        { replacements: { ids: orderIds }, transaction: t });
      deleted.debits = meta?.rowCount ?? '?';
    }
    if (present.payment_proofs) {
      const [, meta] = await sequelize.query(`DELETE FROM payment_proofs WHERE order_id IN (:ids)`,
        { replacements: { ids: orderIds }, transaction: t });
      deleted.payment_proofs = meta?.rowCount ?? '?';
    }
    if (present.orders_products) {
      const [, meta] = await sequelize.query(`DELETE FROM orders_products WHERE order_id IN (:ids)`,
        { replacements: { ids: orderIds }, transaction: t });
      deleted.orders_products = meta?.rowCount ?? '?';
    }
    if (present.wallet_transactions) {
      const [, meta] = await sequelize.query(
        `DELETE FROM wallet_transactions WHERE reference_type = 'order' AND reference_id IN (:ids)`,
        { replacements: { ids: orderIds }, transaction: t });
      deleted.wallet_transactions = meta?.rowCount ?? '?';
    }
    const [, ometa] = await sequelize.query(`DELETE FROM orders WHERE id IN (:ids)`,
      { replacements: { ids: orderIds }, transaction: t });
    deleted.orders = ometa?.rowCount ?? '?';

    // Verify inside the tx
    const [[chk]] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM orders WHERE id IN (:ids)`,
      { replacements: { ids: orderIds }, transaction: t });
    if (chk.n !== 0) throw new Error(`Verificación falló: aún quedan ${chk.n} órdenes. Rollback.`);

    await t.commit();
    console.log('\n✅ COMMIT — filas borradas:', JSON.stringify(deleted));
  } catch (err) {
    await t.rollback();
    console.error('\n🚨 ROLLBACK — no se borró nada. Motivo:', err.message);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
