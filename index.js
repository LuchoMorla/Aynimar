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
// Bootstrap BullMQ cart-recovery worker — starts listening for delayed jobs
require('./workers/cartRecoveryWorker');
// Bootstrap Dropi retry worker — retries PENDING_DROPI_FULFILLMENT orders every 5 min
require('./workers/dropiRetryWorker');
const routerApi = require('./routes');
const cors = require('cors');
const { checkApiKey } = require('./middlewares/authHandler');
const { generalLimiter } = require('./middlewares/rateLimiter');

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
app.use(expressModule.json({ limit: '50mb' }));
app.use(expressModule.urlencoded({ extended: true, limit: '50mb' }));

// implementamos el middleware nativo de express para exportar archivos en formato json
// implementando CORS para los dominios
/* const whitelist = [
  'https://aynimar.vercel.app',
  'https://www.aynimar.com',
  'https://aynimar.com',
  'http://aynimar.vercel.app',
  'http://www.aynimar.com',
  'http://aynimar.com',
  'https://aynimar-luchomorla.vercel.app/',
  'https://circular-merchant.aynimar.com'
];
const options = {
  origin: (origin, callback) => {
    if (whitelist.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('No permitidation, dont do it again, no!'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], // Especifica los métodos HTTP permitidos
  allowedHeaders: ['Content-Type', 'Authorization'], // Especifica los encabezados permitidos
}; */

/*  //comente para que aceptara cualquier tipo de dominio o dirección IP 'http://localhost:8080/frontend.html', 'http://localhost:8080/products',
'http://localhost:8080','http://localhost:3000/',
'http://localhost:3000/recycling',  */

/* app.use(cors(options)); */
// TODO: Add files upload
app.use(cors());
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
  const orderToken = !!(process.env.DROPI_ORDER_TOKEN || process.env.WOO_CONSUMER_SECRET);
  const jwtSecret  = !!process.env.JWT_SECRET;
  const worker     = !!(process.env.DROPI_WORKER_URL && process.env.DROPI_WORKER_KEY);

  const degraded = !groqKey || !orderToken || !jwtSecret;

  res.status(degraded ? 200 : 200).json({
    status:    degraded ? 'degraded' : 'ok',
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      jwt_secret:         jwtSecret,
      dropi_order_token:  orderToken,
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
async function registerTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN no configurado — webhook no registrado.');
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
  console.log(`[Telegram] Registrando webhook en: ${webhookUrl}`);

  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: webhookUrl, drop_pending_updates: false }),
    });
    const data = await res.json();

    if (data.ok) {
      console.log(`[Telegram] Webhook registrado correctamente ✓  URL: ${webhookUrl}`);
    } else {
      console.error(`[Telegram][CRITICAL] setWebhook rechazado por Telegram: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    console.error(`[Telegram][CRITICAL] Error de red al registrar webhook: ${err.message}`);
  }
}

// ── Deploy health notifier ────────────────────────────────────────────────────
// Sends a Telegram message on every Railway deploy with the exact health status.
// Non-blocking — failures are logged but never crash the server.
async function notifyDeployHealth() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // Telegram not configured — skip silently

  const checks = {
    jwt_secret:        !!process.env.JWT_SECRET,
    dropi_order_token: !!(process.env.DROPI_ORDER_TOKEN || process.env.WOO_CONSUMER_SECRET),
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
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    });
    console.log('[DeployHealth] Telegram notificado.');
  } catch (err) {
    console.error('[DeployHealth] Error enviando Telegram:', err.message);
  }
}

const server = app.listen(puerto, '0.0.0.0', () => {
  console.log(`[OK] Server listening on 0.0.0.0:${puerto}`);
  console.log(`[OK] Start time: ${new Date().toISOString()}`);

  // ── Critical env-var checks ───────────────────────────────────────────────
  if (!process.env.DROPI_ORDER_TOKEN && !process.env.WOO_CONSUMER_SECRET) {
    console.error(
      '[CRITICAL] DROPI_ORDER_TOKEN no está configurado en Railway. ' +
      'Las órdenes de Dropi FALLARÁN y quedarán en PENDING_DROPI_FULFILLMENT. ' +
      'Ve a Variables en Railway y añade DROPI_ORDER_TOKEN con el JWT Bearer de tu cuenta Dropi.'
    );
  }

  notifyDeployHealth();   // deploy health report to Telegram on every Railway restart
  registerTelegramWebhook(); // non-blocking — failures are logged, never crash the server
});

server.on('error', (err) => {
  console.error('[FATAL] Server failed to bind:', err.message);
  process.exit(1);
});
