'use strict';
const { DataTypes } = require('sequelize');

const CHALLENGES_TABLE      = 'gamification_challenges';
const USER_CHALLENGES_TABLE = 'gamification_user_challenges';

module.exports = {
  async up(queryInterface) {
    // Biblioteca de retos disponibles
    await queryInterface.createTable(CHALLENGES_TABLE, {
      id: {
        primaryKey: true,
        type: DataTypes.INTEGER,
        autoIncrement: true,
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING(80),
        allowNull: false,
        unique: true,
      },
      title: {
        type: DataTypes.STRING(120),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // 'order' | 'recycle' | 'referral' | 'visit'
      type: {
        type: DataTypes.STRING(40),
        allowNull: false,
      },
      // Créditos Ayni que otorga al completarse
      reward_credits: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 10,
      },
      // Si es true, rota cada día; si es false, es permanente
      is_daily: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });

    // Progreso por usuario
    await queryInterface.createTable(USER_CHALLENGES_TABLE, {
      id: {
        primaryKey: true,
        type: DataTypes.INTEGER,
        autoIncrement: true,
        allowNull: false,
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      challenge_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: CHALLENGES_TABLE, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      // Fecha del día al que aplica este progreso (para retos diarios)
      assigned_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      completed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });

    // Índice único: un usuario no puede tener el mismo reto dos veces en el mismo día
    await queryInterface.addIndex(USER_CHALLENGES_TABLE, ['user_id', 'challenge_id', 'assigned_date'], {
      unique: true,
      name: 'uq_user_challenge_date',
    });

    // Seed de retos base
    await queryInterface.bulkInsert(CHALLENGES_TABLE, [
      {
        slug: 'first_order',
        title: 'Tu primer pedido del día',
        description: 'Completa una compra hoy y gana créditos extra.',
        type: 'order',
        reward_credits: 25,
        is_daily: true,
        active: true,
        created_at: new Date(),
      },
      {
        slug: 'recycle_today',
        title: 'Recicla y gana',
        description: 'Registra un residuo reciclado hoy.',
        type: 'recycle',
        reward_credits: 15,
        is_daily: true,
        active: true,
        created_at: new Date(),
      },
      {
        slug: 'refer_friend',
        title: 'Invita a un amigo',
        description: 'Comparte tu link y que un amigo se registre.',
        type: 'referral',
        reward_credits: 50,
        is_daily: false,
        active: true,
        created_at: new Date(),
      },
      {
        slug: 'visit_3_days',
        title: 'Visita 3 días seguidos',
        description: 'Entra a Aynimar 3 días consecutivos.',
        type: 'visit',
        reward_credits: 20,
        is_daily: false,
        active: true,
        created_at: new Date(),
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable(USER_CHALLENGES_TABLE);
    await queryInterface.dropTable(CHALLENGES_TABLE);
  },
};
