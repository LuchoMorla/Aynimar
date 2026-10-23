'use strict';
/**
 * Facebook Reels — Video Reels API de la Página.
 *   0. GET  /{page-id}?fields=access_token   (token de página desde el usuario de sistema)
 *   1. POST /{page-id}/video_reels upload_phase=start            → video_id
 *   2. POST rupload.facebook.com/video-upload/{v}/{video_id}  header file_url (Meta descarga la URL)
 *   3. POST /{page-id}/video_reels upload_phase=finish video_state=PUBLISHED description  (paso FINAL)
 * Requisitos: 9:16, 3–90 s, mínimo 540x960. Límite: 30 Reels por API en 24 h.
 */
const { PublishError, http } = require('./http');

const ENV = ['META_SYSTEM_USER_TOKEN', 'META_PAGE_ID'];
const ver = (env) => env.META_GRAPH_VERSION || 'v23.0';
const graph = (env) => `https://graph.facebook.com/${ver(env)}`;
const json = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function pageToken(ctx) {
  const { env } = ctx;
  const { data } = await http(ctx, `${graph(env)}/${encodeURIComponent(env.META_PAGE_ID)}?fields=access_token`, { headers: json(env.META_SYSTEM_USER_TOKEN) }, { step: 'fb:page_token' });
  if (!data.access_token) throw new PublishError('permanent', 'fb:page_token sin token (¿permiso CREATE_CONTENT en la página?)');
  return data.access_token;
}

module.exports = {
  envVars: () => ENV,
  isConfigured: (env) => ENV.every((k) => !!env[k]),

  async publish({ post, video }, ctx) {
    const { env } = ctx;
    const page = encodeURIComponent(env.META_PAGE_ID);
    const token = await pageToken(ctx);
    const { data: s } = await http(ctx, `${graph(env)}/${page}/video_reels`, {
      method: 'POST', headers: json(token), body: JSON.stringify({ upload_phase: 'start' }),
    }, { step: 'fb:start' });
    if (!s.video_id) throw new PublishError('temporary', 'fb:start sin video_id');
    const { data: u } = await http(ctx, `https://rupload.facebook.com/video-upload/${ver(env)}/${encodeURIComponent(s.video_id)}`, {
      method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: video.url },
    }, { step: 'fb:upload' });
    if (u.success === false) throw new PublishError('temporary', 'fb:upload rechazado');
    const { data: f } = await http(ctx, `${graph(env)}/${page}/video_reels`, {
      method: 'POST', headers: json(token),
      body: JSON.stringify({ upload_phase: 'finish', video_id: s.video_id, video_state: 'PUBLISHED', description: post.caption }),
    }, { step: 'fb:finish', final: true });
    if (!f.success) throw new PublishError('unknown', 'fb:finish sin success');
    return { externalId: String(s.video_id), url: `https://www.facebook.com/reel/${encodeURIComponent(s.video_id)}` };
  },

  /** true publicado, false error, null aún procesando. */
  async verify({ externalId }, ctx) {
    const token = await pageToken(ctx);
    const { data } = await http(ctx, `${graph(ctx.env)}/${encodeURIComponent(externalId)}?fields=status`, { headers: json(token) }, { step: 'fb:verify' });
    const st = data.status || {};
    if (st.video_status === 'error' || st.publishing_phase?.status === 'error') return false;
    if (st.video_status === 'ready' && (!st.publishing_phase || st.publishing_phase.status === 'complete')) return true;
    return null;
  },
};
