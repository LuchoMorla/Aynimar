'use strict';
/**
 * YouTube Shorts — YouTube Data API v3 (videos.insert, subida reanudable), OAuth con refresh token
 * del canal (scope youtube.upload). Vídeo vertical ≤ 3 min = Short.
 *   0. POST oauth2.googleapis.com/token  grant_type=refresh_token          → access_token
 *   1. POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status  → Location
 *   2. PUT  Location con los bytes del mp4  (paso FINAL)                    → video id
 * Coste: 1600 unidades de cuota por subida (10.000/día). Privacidad por YOUTUBE_PRIVACY
 * (por defecto 'private' hasta confirmar que el proyecto puede publicar en público).
 */
const { PublishError, http } = require('./http');

const ENV = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'];

async function accessToken(ctx) {
  const { env } = ctx;
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID, client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN, grant_type: 'refresh_token',
  });
  const { data } = await http(ctx, 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }, { step: 'yt:token' });
  if (!data.access_token) throw new PublishError('permanent', 'yt:token sin access_token');
  return data.access_token;
}

/** Título = primera línea del texto, ≤100 caracteres. */
function titleOf(caption) {
  return String(caption).split('\n')[0].trim().slice(0, 100) || 'Aynimar';
}

module.exports = {
  envVars: () => ENV,
  isConfigured: (env) => ENV.every((k) => !!env[k]),
  titleOf,

  async publish({ post, video }, ctx) {
    if (!video.buffer) throw new PublishError('permanent', 'yt: faltan los bytes del vídeo');
    const token = await accessToken(ctx);
    const meta = {
      snippet: { title: titleOf(post.caption), description: post.caption, categoryId: '22' },
      status: { privacyStatus: ctx.env.YOUTUBE_PRIVACY || 'private', selfDeclaredMadeForKids: false },
    };
    const { headers } = await http(ctx, 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(video.buffer.length), 'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(meta),
    }, { step: 'yt:init' });
    const location = headers.get('location');
    if (!location) throw new PublishError('temporary', 'yt:init sin Location');
    const { data } = await http(ctx, location, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' }, body: video.buffer,
    }, { step: 'yt:upload', final: true, timeoutMs: 600000 });
    if (!data.id) throw new PublishError('unknown', 'yt:upload sin id');
    return { externalId: data.id, url: `https://www.youtube.com/shorts/${encodeURIComponent(data.id)}` };
  },

  async verify({ externalId }, ctx) {
    const token = await accessToken(ctx);
    const { data } = await http(ctx, `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(externalId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }, { step: 'yt:verify' });
    const st = data.items?.[0]?.status;
    if (!st) return false;
    if (st.uploadStatus === 'rejected' || st.uploadStatus === 'failed') return false;
    return st.uploadStatus === 'processed' ? true : null;
  },
};
