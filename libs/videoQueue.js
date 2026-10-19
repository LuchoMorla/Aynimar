'use strict';
/* eslint-disable no-console */
/**
 * Cola de render de vídeos: un render a la vez.
 *  - Con REDIS_URL: BullMQ ('product-video', concurrency 1, sin reintentos para
 *    no mandar dos veces el mismo vídeo a Telegram).
 *  - Sin Redis (staging): cadena de promesas en memoria, máximo MAX_PENDING en espera.
 *    ponytail: se pierde lo encolado si el proceso reinicia; aceptable para un disparo manual de admin.
 */
const videoService = require('../integrations/videoService');

const QUEUE = 'product-video';
const MAX_PENDING = 3;

let queue = null;
if (process.env.REDIS_URL) {
  const { Queue, Worker } = require('bullmq');
  const { connection, queueConnection } = require('./cartRecoveryQueue');
  queue = new Queue(QUEUE, { connection: queueConnection });
  const worker = new Worker(QUEUE, (job) => videoService.createProductVideo(job.data), { connection, concurrency: 1, lockDuration: 180000 });
  worker.on('failed', (job, err) => console.error(`[Video] job ${job?.data?.ref} falló: ${err.message}`));
}

let chain = Promise.resolve();
let pending = 0;

/** @returns {Promise<{mode:'bullmq'|'memory'}>} lanza {status:429} si la cola en memoria está llena */
async function enqueueVideo(data) {
  if (queue) {
    await queue.add('render', data, { attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
    return { mode: 'bullmq' };
  }
  if (pending >= MAX_PENDING) throw Object.assign(new Error('cola de vídeos llena'), { status: 429 });
  pending++;
  chain = chain
    .then(() => videoService.createProductVideo(data))
    .catch((err) => console.error(`[Video] ${data.ref} falló: ${err.message}`))
    .finally(() => { pending--; });
  return { mode: 'memory' };
}

module.exports = { enqueueVideo, MAX_PENDING };
