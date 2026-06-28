const express  = require('express');
const passport = require('passport');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../libs/sequelize');

const router = express.Router();

// Ecuador es UTC-5. Medianoche local = 05:00 UTC del día siguiente.
function midnightEcuador() {
  const now = new Date();
  const ec  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }));
  const midnight = new Date(ec);
  midnight.setHours(24, 0, 0, 0);
  // Convertir de vuelta a UTC
  const offsetMs = now.getTime() - ec.getTime();
  return new Date(midnight.getTime() + offsetMs);
}

function hoursFromNow(h) {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

// Plantillas de retos de compra (70 % del pool)
const PURCHASE_TEMPLATES = [
  { slug: 'buy_30_today',  title: 'Compra por $30 hoy', description: 'Realiza un pedido de al menos $30 antes de medianoche.',           type: 'order', rewardCredits: 30, threshold: 30,  ttlHours: null },
  { slug: 'buy_50_3h',     title: 'Compra $50 en 3 horas', description: 'Tu cofre de recompensas espera: compra $50 en las próximas 3 h.', type: 'order', rewardCredits: 50, threshold: 50,  ttlHours: 3   },
  { slug: 'buy_20_boost',  title: 'Impulso rápido: $20', description: 'Suma $20 a tu carrito y desbloquea Aynicréditos extra.',           type: 'order', rewardCredits: 20, threshold: 20,  ttlHours: 6   },
  { slug: 'buy_75_boss',   title: 'Compra Boss: $75', description: 'La compra más grande siembra el árbol más alto. Compra $75 hoy.',      type: 'order', rewardCredits: 75, threshold: 75,  ttlHours: null },
  { slug: 'buy_40_night',  title: 'Oferta de noche: $40', description: 'Solo hasta medianoche: $40 en tu carrito = cofre garantizado.',   type: 'order', rewardCredits: 40, threshold: 40,  ttlHours: null },
];

// Plantillas de retos de siembra (30 % del pool)
const SEED_TEMPLATES = [
  { slug: 'recycle_today', title: 'Siembra hoy', description: 'Registra un material recuperable y suma puntos de impacto.',           type: 'recycle',  rewardCredits: 15, threshold: null, ttlHours: null },
  { slug: 'refer_friend',  title: 'Invita a sembrar', description: 'Comparte Aynimar — por cada amigo registrado ganas 50 créditos.', type: 'referral', rewardCredits: 50, threshold: null, ttlHours: null },
  { slug: 'visit_streak',  title: 'Racha de 3 días', description: 'Visita Aynimar 3 días seguidos y activa tu bono de racha.',        type: 'visit',    rewardCredits: 20, threshold: null, ttlHours: null },
];

/**
 * Selecciona ~3 retos del día: 2 de compra (70%) + 1 de siembra (30%).
 * La selección rota según el día del año para evitar repetición exacta.
 */
function selectDailyTemplates(dayOfYear) {
  const pIdx = dayOfYear % PURCHASE_TEMPLATES.length;
  const p2   = (dayOfYear + 2) % PURCHASE_TEMPLATES.length;
  const sIdx = dayOfYear % SEED_TEMPLATES.length;
  return [
    PURCHASE_TEMPLATES[pIdx],
    PURCHASE_TEMPLATES[p2 !== pIdx ? p2 : (p2 + 1) % PURCHASE_TEMPLATES.length],
    SEED_TEMPLATES[sIdx],
  ];
}

/**
 * GET /api/v1/gamification/daily-challenges
 *
 * Devuelve los retos del día con deadline calculado y threshold de compra.
 * 70 % son retos de compra, 30 % de siembra/reciclaje.
 */
router.get(
  '/daily-challenges',
  passport.authenticate('jwt', { session: false }),
  async (req, res, next) => {
    try {
      const userId    = req.user.sub;
      const now       = new Date();
      const today     = now.toISOString().slice(0, 10);
      const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);

      const templates = selectDailyTemplates(dayOfYear);

      // Upsert filas en gamification_user_challenges para los retos de la DB
      await sequelize.query(
        `
        INSERT INTO gamification_user_challenges (user_id, challenge_id, assigned_date, completed, created_at)
        SELECT :userId, c.id, :today, false, NOW()
        FROM gamification_challenges c
        WHERE c.active = true
          AND c.is_daily = true
          AND NOT EXISTS (
            SELECT 1 FROM gamification_user_challenges uc
            WHERE uc.user_id = :userId
              AND uc.challenge_id = c.id
              AND uc.assigned_date = :today
          )
        `,
        { replacements: { userId, today }, type: QueryTypes.INSERT }
      );

      // Leer retos persistidos en DB
      const dbChallenges = await sequelize.query(
        `
        SELECT
          c.id, c.slug, c.title, c.description, c.type,
          c.reward_credits   AS "rewardCredits",
          c.is_daily         AS "isDaily",
          COALESCE(uc.completed, false) AS completed,
          uc.completed_at    AS "completedAt"
        FROM gamification_challenges c
        LEFT JOIN gamification_user_challenges uc
          ON uc.challenge_id = c.id
          AND uc.user_id = :userId
          AND (c.is_daily = false OR uc.assigned_date = :today)
        WHERE c.active = true
          AND (c.is_daily = true OR COALESCE(uc.completed, false) = false)
        ORDER BY completed ASC, c.reward_credits DESC
        `,
        { replacements: { userId, today }, type: QueryTypes.SELECT }
      );

      const midnight = midnightEcuador();

      // Enriquecer con deadline y threshold usando las plantillas rotativas
      const enriched = templates.map((tpl) => {
        const db       = dbChallenges.find((r) => r.slug === tpl.slug) ?? {};
        const deadline = tpl.ttlHours ? hoursFromNow(tpl.ttlHours) : midnight;

        return {
          id:            db.id    ?? `virtual_${tpl.slug}`,
          slug:          tpl.slug,
          title:         tpl.title,
          description:   tpl.description,
          type:          tpl.type,
          rewardCredits: tpl.rewardCredits,
          threshold:     tpl.threshold,        // null si no es de compra
          deadline:      deadline.toISOString(),
          deadlineMs:    deadline.getTime() - now.getTime(), // ms restantes al momento de respuesta
          isDaily:       true,
          completed:     db.completed ?? false,
          completedAt:   db.completedAt ?? null,
        };
      });

      // Añadir retos permanentes sin completar que ya estaban en DB
      const permanent = dbChallenges.filter(
        (r) => !r.isDaily && !r.completed && !enriched.find((e) => e.slug === r.slug)
      );

      res.json([...enriched, ...permanent]);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/gamification/complete-challenge
 *
 * Valida que el challenge no haya expirado y que el monto (si aplica)
 * supere el threshold. Acredita créditos al wallet si pasa.
 */
router.post(
  '/complete-challenge',
  passport.authenticate('jwt', { session: false }),
  async (req, res, next) => {
    try {
      const userId         = req.user.sub;
      const { slug, orderAmountUsd } = req.body;
      const today          = new Date().toISOString().slice(0, 10);

      if (!slug) return res.status(400).json({ message: 'slug requerido' });

      // Buscar plantilla para validar threshold y deadline
      const tpl = [...PURCHASE_TEMPLATES, ...SEED_TEMPLATES].find((t) => t.slug === slug);

      // Validar threshold si es reto de compra
      if (tpl?.threshold != null) {
        const amount = parseFloat(orderAmountUsd ?? 0);
        if (amount < tpl.threshold) {
          return res.status(422).json({
            message: `El pedido debe superar $${tpl.threshold}`,
            threshold: tpl.threshold,
            received: amount,
          });
        }
      }

      const [challenge] = await sequelize.query(
        `SELECT id, reward_credits FROM gamification_challenges WHERE slug = :slug AND active = true LIMIT 1`,
        { replacements: { slug }, type: QueryTypes.SELECT }
      );

      // Si el reto no existe en DB, usar el crédito de la plantilla directamente
      const rewardCredits = challenge?.reward_credits ?? tpl?.rewardCredits ?? 0;
      const challengeId   = challenge?.id;

      if (challengeId) {
        const [uc] = await sequelize.query(
          `SELECT completed FROM gamification_user_challenges
           WHERE user_id = :userId AND challenge_id = :challengeId AND assigned_date = :today LIMIT 1`,
          { replacements: { userId, challengeId, today }, type: QueryTypes.SELECT }
        );
        if (uc?.completed) return res.status(409).json({ message: 'Reto ya completado hoy' });

        await sequelize.query(
          `UPDATE gamification_user_challenges
           SET completed = true, completed_at = NOW()
           WHERE user_id = :userId AND challenge_id = :challengeId AND assigned_date = :today`,
          { replacements: { userId, challengeId, today }, type: QueryTypes.UPDATE }
        );
      }

      // Acreditar créditos en wallet
      await sequelize.query(
        `UPDATE wallets SET credit = credit + :credits WHERE user_id = :userId`,
        { replacements: { credits: rewardCredits, userId }, type: QueryTypes.UPDATE }
      );

      // Calcular descuento aleatorio (5–15%) para el cofre
      const chestDiscountPct = 5 + Math.floor(Math.random() * 11); // 5..15

      res.json({
        credited: rewardCredits,
        chestDiscountPct,
        message: `¡Reto completado! +${rewardCredits} créditos`,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
