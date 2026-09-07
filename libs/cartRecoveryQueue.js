const { Queue } = require('bullmq');

function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    };
  }
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
  };
}

const baseConnection = getRedisConnection();

// Conexión para el WORKER (workers/cartRecoveryWorker.js) — sin cambios de
// comportamiento respecto a antes. BullMQ EXIGE `maxRetriesPerRequest: null`
// en la conexión de un Worker (usa comandos bloqueantes internamente); se
// deja explícito en vez de implícito, pero el valor efectivo es el mismo.
// Un worker en background reintentando indefinidamente es aceptable — no
// bloquea ninguna request HTTP.
const connection = {
  ...baseConnection,
  maxRetriesPerRequest: null,
};

// Conexión para la COLA (productora — usada dentro de Services/orderService.js,
// en el camino de una request HTTP real). A diferencia del worker, aquí SÍ
// acotamos los reintentos: recuperación de carrito es una función secundaria
// y nunca debe poder retrasar indefinidamente la respuesta de
// guest-order/add-item-guest si Redis no está disponible (ver
// Services/orderService.js — el enqueue ya es fire-and-forget, no bloquea la
// respuesta; esta configuración evita además que la propia llamada a Redis
// quede reintentando para siempre en segundo plano).
//   - maxRetriesPerRequest: 1 → un solo intento por comando, sin reintentos.
//   - connectTimeout: 2000ms  → no esperar más de 2s a que abra la conexión.
//   - retryStrategy: null tras el primer fallo → no reintentar la conexión.
const queueConnection = {
  ...baseConnection,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  retryStrategy: () => null,
};

const cartRecoveryQueue = new Queue('cart-recovery', { connection: queueConnection });

module.exports = { cartRecoveryQueue, connection };
