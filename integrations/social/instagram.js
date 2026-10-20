'use strict';
/**
 * Instagram Reels — Instagram Graph API (Content Publishing), token de usuario de sistema de Meta.
 *   1. POST /{ig-user-id}/media  media_type=REELS, video_url, caption  → contenedor
 *   2. GET  /{container-id}?fields=status_code  hasta FINISHED (ERROR → permanente)
 *   3. POST /{ig-user-id}/media_publish creation_id  (paso FINAL)  → media id
 *   4. GET  /{media-id}?fields=permalink
 * Límite de Meta: 100 publicaciones por API en 24 h por cuenta.
 */
const { PublishError, http } = require('./http');

const ENV = ['META_SYSTEM_USER_TOKEN', 'META_IG_USER_ID'];
const graph = (env) => `https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v23.0'}`;
const auth = (env) => ({ Authorization: `Bearer ${env.META_SYSTEM_USER_TOKEN}`, 'Content-Type': 'application/json' });

module.exports = {
  envVars: () => ENV,
  isConfigured: (env) => ENV.every((k) => !!env[k]),

  async publish({ post, video }, ctx) {
    const { env } = ctx;
    const ig = encodeURIComponent(env.META_IG_USER_ID);
    const { data: c } = await http(ctx, `${graph(env)}/${ig}/media`, {
      method: 'POST', headers: auth(env),
      body: JSON.stringify({ media_type: 'REELS', video_url: video.url, caption: post.caption, share_to_feed: true }),
    }, { step: 'ig:container' });
    if (!c.id) throw new PublishError('temporary', 'ig:container sin id');
    // ponytail: sondeo simple cada 5 s, máx. 5 min (los Reels cortos tardan segundos).
    for (let i = 0; ; i++) {
      const { data: s } = await http(ctx, `${graph(env)}/${encodeURIComponent(c.id)}?fields=status_code`, { headers: auth(env) }, { step: 'ig:status' });
      if (s.status_code === 'FINISHED') break;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new PublishError('permanent', `ig:status ${s.status_code}`);
      if (i >= 60) throw new PublishError('temporary', 'ig:status sin terminar tras 5 min');
      await ctx.sleep(5000);
    }
    const { data: p } = await http(ctx, `${graph(env)}/${ig}/media_publish`, {
      method: 'POST', headers: auth(env), body: JSON.stringify({ creation_id: c.id }),
    }, { step: 'ig:publish', final: true });
    if (!p.id) throw new PublishError('unknown', 'ig:publish sin id');
    let url = null;
    try { url = (await http(ctx, `${graph(env)}/${encodeURIComponent(p.id)}?fields=permalink`, { headers: auth(env) }, { step: 'ig:permalink' })).data.permalink || null; } catch { /* se verifica después */ }
    return { externalId: p.id, url };
  },

  async verify({ externalId }, ctx) {
    const { data } = await http(ctx, `${graph(ctx.env)}/${encodeURIComponent(externalId)}?fields=id,permalink`, { headers: auth(ctx.env) }, { step: 'ig:verify' });
    return data.id === externalId;
  },
};
