const express  = require('express');
const passport = require('passport');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../libs/sequelize');

const router = express.Router();

/**
 * GET /api/v1/gamification/daily-challenges
 *
 * Devuelve los retos diarios personalizados para el usuario autenticado.
 * - Retos activos del día (is_daily=true), asignados con su estado de completado
 * - Retos permanentes (is_daily=false) que el usuario aún no completó
 */
router.get(
  '/daily-challenges',
  passport.authenticate('jwt', { session: false }),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const today  = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      // Upsert: crear fila en user_challenges si no existe para hoy
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

      // Leer todos los retos del usuario para hoy (diarios de hoy + permanentes sin completar)
      const challenges = await sequelize.query(
        `
        SELECT
          c.id,
          c.slug,
          c.title,
          c.description,
          c.type,
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
          AND (
            c.is_daily = true
            OR COALESCE(uc.completed, false) = false
          )
        ORDER BY completed ASC, c.reward_credits DESC
        `,
        { replacements: { userId, today }, type: QueryTypes.SELECT }
      );

      res.json(challenges);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/gamification/complete-challenge
 *
 * El servidor llama a este endpoint internamente (desde orderRouter, recyclerRouter, etc.)
 * para marcar un reto como completado y acreditar los Aynicréditos al usuario.
 */
router.post(
  '/complete-challenge',
  passport.authenticate('jwt', { session: false }),
  async (req, res, next) => {
    try {
      const userId = req.user.sub;
      const { slug }   = req.body;
      const today  = new Date().toISOString().slice(0, 10);

      if (!slug) return res.status(400).json({ message: 'slug requerido' });

      const [challenge] = await sequelize.query(
        `SELECT id, reward_credits FROM gamification_challenges WHERE slug = :slug AND active = true LIMIT 1`,
        { replacements: { slug }, type: QueryTypes.SELECT }
      );

      if (!challenge) return res.status(404).json({ message: 'Reto no encontrado' });

      const [userChallenge] = await sequelize.query(
        `SELECT id, completed FROM gamification_user_challenges
         WHERE user_id = :userId AND challenge_id = :challengeId
           AND (assigned_date = :today OR assigned_date IS NULL)
         LIMIT 1`,
        { replacements: { userId, challengeId: challenge.id, today }, type: QueryTypes.SELECT }
      );

      if (userChallenge?.completed) {
        return res.status(409).json({ message: 'Reto ya completado' });
      }

      await sequelize.query(
        `UPDATE gamification_user_challenges
         SET completed = true, completed_at = NOW()
         WHERE user_id = :userId AND challenge_id = :challengeId
           AND assigned_date = :today`,
        { replacements: { userId, challengeId: challenge.id, today }, type: QueryTypes.UPDATE }
      );

      // Acreditar Aynicréditos en wallet
      await sequelize.query(
        `UPDATE wallets SET credit = credit + :credits WHERE user_id = :userId`,
        { replacements: { credits: challenge.reward_credits, userId }, type: QueryTypes.UPDATE }
      );

      res.json({ credited: challenge.reward_credits, message: '¡Reto completado!' });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
