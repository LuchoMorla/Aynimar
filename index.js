/* eslint-disable no-console */
// Sentry must be initialized before any other module so it can instrument them.
const Sentry = require('./libs/sentry');
const log = require('./libs/logger');

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  log.error('unhandledRejection', { err_message: reason?.message ?? String(reason) });
});

process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  log.error('uncaughtException', { err_message: err?.message ?? String(err) });
});

const expressModule = require('express');
// Bootstrap BullMQ cart-recovery worker — starts listening for delayed jobs.
// Sin Redis configurado (p. ej. staging) no arranca: si no, reintenta 127.0.0.1:6379 sin fin
// y llena los logs (~70k líneas/día). Mismo criterio que libs/videoQueue.js.
if (process.env.REDIS_URL || process.env.REDIS_HOST) require('./workers/cartRecoveryWorker');
// Bootstrap Dropi retry worker — retries PENDING_DROPI_FULFILLMENT orders every 5 min
require('./workers/dropiRetryWorker');
const routerApi = require('./routes');
const cors = require('cors');
const { checkApiKey } = require('./middlewares/authHandler');
const { generalLimiter } = require('./middlewares/rateLimiter');
const {
  getTelegramToken,
  telegramDisabledReason,
  buildSetWebhookBody,
  getAdminChatId,
} = require('./libs/telegramSecurity');

//Los middlewares del tipo error se deben crear despues de establecer el routing de nuestra aplicacion
const {
  logErrors,
  errorHandler,
  boomErrorHandler,
  ormErrorHandler,
} = require('./middlewares/errorsHandler');

const app = expressModule();

// Railway sits behind a reverse proxy — trust first hop so req.ip resolves from X-Forwarded-For
app.set('trust proxy', 1);

const puerto = process.env.PORT || 8080;

// body parsers — must be registered before cors and routes
// La entrada del hub (/api/v1/hub/) firma los bytes crudos: solo ahí se conserva req.rawBody.
app.use(expressModule.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/v1/hub/')) req.rawBody = Buffer.from(buf);
  },
}));
app.use(expressModule.urlencoded({ extended: true, limit: '50mb' }));

// ── CORS — Fase A (A4): whitelist en middlewares/corsOptions.js ──────────────
const { corsOptions } = require('./middlewares/corsOptions');
app.use(cors(corsOptions));
//importare el index.js de auth para los login
require('./utils/auth');

//administracion de primeras rutas

app.get('/', (req, res) => {
  res.send(
    'Hola mi server en express </br> <a href="http://localhost:8080/api/v1/products">link productos</a>'
  );
});

// ── Health check — no auth, no DB hit — Railway uses this for uptime monitoring ──
app.get('/health', (req, res) => {
  const groqKey    = !!(process.env.GROQ_API_KEY || process.env.GROQ_IA_KEY);
  const orderToken = !!process.env.DROPI_INTEGRATION_KEY;
  const jwtSecret  = !!process.env.JWT_SECRET;
  const worker     = !!(process.env.DROPI_WORKER_URL && process.env.DROPI_WORKER_KEY);

  // El token de integración solo hace falta con el transporte http (ni WOO_CONSUMER_SECRET ni
  // DROPI_ORDER_TOKEN cuentan). Con transporte mock (por defecto) su ausencia no degrada.
  const degraded = !groqKey || !jwtSecret || (process.env.DROPI_ORDER_TRANSPORT === 'http' && !orderToken);

  res.status(degraded ? 200 : 200).json({
    status:    degraded ? 'degraded' : 'ok',
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      jwt_secret:         jwtSecret,
      dropi_integration_key: orderToken,
      groq_api_key:       groqKey,
      cloudflare_worker:  worker,
    },
  });
});

// un ejemplo de protección de nuestra api con un key o apiKey de ejemplo
app.get('/nueva-ruta', checkApiKey, (req, res) => {
  res.send('hola, soy tu nueva ruta');
});

// Global rate limit — 100 req/15 min per IP (health excluded)
app.use(generalLimiter);

// Structured HTTP access log — captured by Railway log aggregation
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms    = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level]('http', {
      method: req.method,
      path:   req.path,
      status: res.statusCode,
      ms,
      ip: (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress,
    });
  });
  next();
});

routerApi(app);

// Create app_settings table if it doesn't exist (safe — does not alter existing tables)
const { AppSetting } = require('./db/models/appSettingModel');
AppSetting.sync({ force: false }).catch((err) =>
  console.error('[AppSetting] Error creando tabla app_settings:', err.message)
);

// Sentry error handler must come BEFORE our own error handlers but AFTER routes.
// It captures 5xx errors and attaches request context to the Sentry event.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

//Vamos a adicionar los middlewares de correccion de errores, hay que tener mucha delicadeza con el orden de definicion de los errores, el momento en que se los ejecuta, como una cadena
app.use(logErrors);
app.use(ormErrorHandler);
app.use(boomErrorHandler);
app.use(errorHandler);

// ── Telegram webhook auto-registration ───────────────────────────────────────
// Runs once after the server is up. Uses BACKEND_URL (set manually in Railway)
// or falls back to RAILWAY_PUBLIC_DOMAIN (injected automatically by Railway).
// F0: siempre con secret_token (el handler rechaza updates sin él) y, fuera de
// production, solo con el bot de pruebas (libs/telegramSecurity.js).
async function registerTelegramWebhook() {
  const token = getTelegramToken();
  if (!token) {
    console.warn(`[Telegram] Webhook no registrado — ${telegramDisabledReason()}.`);
    return;
  }

  const rawDomain =
    process.env.BACKEND_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null);

  if (!rawDomain) {
    console.error('[Telegram][CRITICAL] No se puede registrar el webhook — define BACKEND_URL en Railway variables (ej: https://tu-proyecto.railway.app).');
    return;
  }

  const webhookUrl = `${rawDomain.replace(/\/$/, '')}/api/v1/ai/telegram/webhook`;
  const { body, error } = buildSetWebhookBody(webhookUrl);
  if (error) {
    console.error(`[Telegram][CRITICAL] Webhook no registrado — ${error}. Los updates entrantes serán rechazados hasta corregirlo.`);
    return;
  }
  console.log(`[Telegram] Registrando webhook en: ${webhookUrl}${body.allowed_updates ? ` (allowed_updates=${body.allowed_updates.join(',')})` : ''}`);

  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();

    if (data.ok) {
      console.log(`[Telegram] Webhook registrado correctamente ✓  URL: ${webhookUrl}`);
    } else {
      // Solo la descripción: nunca el cuerpo enviado (contiene secret_token).
      console.error(`[Telegram][CRITICAL] setWebhook rechazado por Telegram: ${data.error_code ?? ''} ${data.description ?? ''}`);
    }
  } catch (err) {
    console.error(`[Telegram][CRITICAL] Error de red al registrar webhook: ${err.name}`);
  }
}

// ── Deploy health notifier ────────────────────────────────────────────────────
// Sends a Telegram message on every Railway deploy with the exact health status.
// Non-blocking — failures are logged but never crash the server.
async function notifyDeployHealth() {
  const token  = getTelegramToken();
  const chatId = getAdminChatId();
  if (!token || !chatId) return; // Telegram not configured — skip silently

  const checks = {
    jwt_secret:        !!process.env.JWT_SECRET,
    dropi_integration_key: !!process.env.DROPI_INTEGRATION_KEY,
    groq_api_key:      !!(process.env.GROQ_API_KEY || process.env.GROQ_IA_KEY),
    telegram_bot:      !!process.env.TELEGRAM_BOT_TOKEN,
  };

  const criticalFails = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);

  const statusLine = criticalFails.length === 0
    ? '✅ <b>Deploy OK — sistema estable</b>'
    : `⚠️ <b>Deploy DEGRADADO — ${criticalFails.length} var(s) faltante(s)</b>`;

  const checkLines = Object.entries(checks)
    .map(([k, ok]) => `${ok ? '✅' : '🚨'} ${k}`)
    .join('\n');

  const deployId = process.env.RAILWAY_DEPLOYMENT_ID
    ? `Deploy: <code>${process.env.RAILWAY_DEPLOYMENT_ID.slice(0, 8)}</code>\n`
    : '';

  const msg =
    `${statusLine}\n\n` +
    `${deployId}` +
    `🕐 ${new Date().toISOString()}\n\n` +
    checkLines +
    (criticalFails.length > 0
      ? `\n\n🚨 Acción requerida:\n${criticalFails.map((k) => `  • Añade <code>${k.toUpperCase()}</code> en Railway Variables`).join('\n')}`
      : '');

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (data.ok) console.log('[DeployHealth] Telegram notificado.');
    else console.error(`[DeployHealth] Telegram rechazó el envío: ${data.error_code ?? resp.status} ${data.description ?? ''}`);
  } catch (err) {
    console.error('[DeployHealth] Error enviando Telegram:', err.message);
  }
}

const server = app.listen(puerto, '0.0.0.0', () => {
  console.log(`[OK] Server listening on 0.0.0.0:${puerto}`);
  console.log(`[OK] Start time: ${new Date().toISOString()}`);

  // ── Critical env-var checks ───────────────────────────────────────────────
  // Automatización de pedidos (docs/ORDER_AUTOMATION.md): sin interruptor no se envía nada a Dropi.
  const orderMode = (process.env.DROPI_ORDER_AUTOMATION || 'off').toLowerCase();
  // Host .co, /api/v1/orders, sin flag o sin DROPI_INTEGRATION_KEY → http rechazado al arrancar
  // (preDispatch bloquea cada pedido con esa misma razón; nunca se llama a Dropi).
  const dropiOrders = require('./integrations/dropi/dropiAdapter');
  const transportError = dropiOrders.orderTransportError();
  const orderTransport = dropiOrders.orderTransportName() === 'mock' ? 'mock' : (transportError ? 'http RECHAZADO' : 'http (api.dropi.ec)');
  console.log(`[OrderAutomation] DROPI_ORDER_AUTOMATION=${orderMode} · transporte de órdenes Dropi: ${orderTransport}`);
  if (transportError) console.error(`[OrderAutomation] ${transportError}`);

  notifyDeployHealth();   // deploy health report to Telegram on every Railway restart
  registerTelegramWebhook(); // non-blocking — failures are logged, never crash the server
});

server.on('error', (err) => {
  console.error('[FATAL] Server failed to bind:', err.message);
  process.exit(1);
});
