'use strict';
/**
 * Adaptador mock — determinista, para pruebas y staging. Nunca disponible en production
 * (allowedNetworks lo excluye y isConfigured devuelve false).
 *
 * Fallos simulados con una marca en el texto (solo este adaptador la interpreta):
 *   [mock-fail:temporary:N]  los N primeros intentos fallan con error temporal
 *   [mock-fail:permanent]    error permanente
 *   [mock-fail:unknown]      resultado incierto en el paso final
 * Cada publicación se registra (una línea JSON) en SOCIAL_MOCK_LOG si está definido
 * (O_APPEND: válido entre procesos) y siempre en memoria (`published`).
 */
const fs = require('fs');
const { PublishError } = require('./http');
const { isProductionEnv } = require('../../libs/telegramSecurity');

const published = [];

module.exports = {
  published,
  envVars: () => [],
  isConfigured: (env) => !isProductionEnv(env),

  async publish({ post, piece }, ctx) {
    const m = /\[mock-fail:(temporary|permanent|unknown)(?::(\d+))?\]/.exec(post.caption);
    if (m && m[1] === 'temporary' && post.attempts <= Number(m[2] || 1)) throw new PublishError('temporary', `mock: fallo temporal (intento ${post.attempts})`);
    if (m && m[1] === 'permanent') throw new PublishError('permanent', 'mock: fallo permanente');
    if (m && m[1] === 'unknown') throw new PublishError('unknown', 'mock: resultado incierto');
    const rec = { postId: post.id, pieceId: piece.id, network: post.network, pid: process.pid, at: Date.now() };
    published.push(rec);
    if (ctx.env.SOCIAL_MOCK_LOG) fs.appendFileSync(ctx.env.SOCIAL_MOCK_LOG, `${JSON.stringify(rec)}\n`);
    return { externalId: `mock_${post.id}`, url: `https://mock.invalid/p/${post.id}` };
  },

  async verify({ externalId }) {
    return /^mock_\d+$/.test(externalId);
  },
};
