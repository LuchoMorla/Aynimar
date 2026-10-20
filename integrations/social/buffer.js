'use strict';
/**
 * Buffer — API GraphQL (https://api.buffer.com, Authorization: Bearer <BUFFER_API_KEY>).
 * Vía para TikTok (Buffer es un tercero auditado: publica en público) y, si se elige, YouTube.
 * La cola y el horario son NUESTROS: cuando la publicación vence se envía con mode=shareNow,
 * así nunca se acumulan posts en la cola de Buffer (Free: 10 por canal, 3000 peticiones/30 días).
 *   createPost(input: { channelId, text, schedulingType: automatic, mode: shareNow,
 *                       assets: [{ video: { url } }], metadata })   (paso FINAL)
 *   post(input: { id }) { status externalLink error { message } }  → sent | error | sending…
 * GraphQL responde 200 también con error: se miran `errors[].extensions.code` y MutationError.
 */
const { PublishError, http } = require('./http');

const CHANNEL_ENV = { tiktok: 'BUFFER_CHANNEL_TIKTOK', youtube: 'BUFFER_CHANNEL_YOUTUBE' };

async function gql(ctx, query, variables, { final = false, step }) {
  const { data } = await http(ctx, 'https://api.buffer.com', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.env.BUFFER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, { final, step });
  const e = data.errors?.[0];
  if (e) {
    const code = e.extensions?.code || '';
    const msg = `${step}: ${code} ${String(e.message || '').slice(0, 200)}`;
    if (code === 'RATE_LIMIT_EXCEEDED') throw new PublishError('temporary', msg);
    if (code === 'UNEXPECTED') throw new PublishError(final ? 'unknown' : 'temporary', msg);
    throw new PublishError('permanent', msg);
  }
  return data.data || {};
}

const CREATE = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id status externalLink } }
    ... on MutationError { message }
  }
}`;
const GET = 'query GetPost($input: PostInput!) { post(input: $input) { id status externalLink error { message } } }';

module.exports = {
  supports: (network) => !!CHANNEL_ENV[network],
  envVars: (network) => ['BUFFER_API_KEY', CHANNEL_ENV[network]].filter(Boolean),
  isConfigured: (env, network) => !!(env.BUFFER_API_KEY && env[CHANNEL_ENV[network]]),

  async publish({ post, video }, ctx) {
    const network = post.network;
    const input = {
      channelId: ctx.env[CHANNEL_ENV[network]],
      text: post.caption,
      schedulingType: 'automatic',
      mode: 'shareNow',
      assets: [{ video: { url: video.url } }],
    };
    if (network === 'youtube') {
      const { titleOf } = require('./youtube');
      input.metadata = { youtube: { title: titleOf(post.caption), categoryId: '22', madeForKids: false, privacy: ctx.env.YOUTUBE_PRIVACY || 'private' } };
    }
    const d = await gql(ctx, CREATE, { input }, { final: true, step: 'buffer:createPost' });
    const r = d.createPost || {};
    // MutationError (validación/límite) → Buffer no creó el post.
    if (!r.post) throw new PublishError('permanent', `buffer:createPost ${String(r.message || 'sin post').slice(0, 200)}`);
    return { externalId: r.post.id, url: r.post.externalLink || null };
  },

  /** true enviado, false error, null aún en cola/enviando. */
  async verify({ externalId }, ctx) {
    const d = await gql(ctx, GET, { input: { id: externalId } }, { step: 'buffer:post' });
    const st = d.post?.status;
    if (st === 'sent') return true;
    if (st === 'error' || !d.post) return false;
    return null;
  },
};
