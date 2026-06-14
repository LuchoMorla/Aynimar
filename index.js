// Catch unhandled promise rejections before they crash the process in Node 15+
// (Sequelize pool events, DB reconnects, and background tasks can emit these)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] NOT crashing:', reason?.message ?? reason);
});

// Catch synchronous throws + EventEmitter 'error' events not handled by listeners
// (pg pool emits 'error' events that without this handler crash the process)
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] NOT crashing:', err?.message ?? err);
});

const expressModule = require('express');
const routerApi = require('./routes');
const cors = require('cors');
const { checkApiKey } = require('./middlewares/authHandler');

//Los middlewares del tipo error se deben crear despues de establecer el routing de nuestra aplicacion
const {
  logErrors,
  errorHandler,
  boomErrorHandler,
  ormErrorHandler,
} = require('./middlewares/errorsHandler');

const app = expressModule();

const puerto = process.env.PORT || 8080;

// body parsers — must be registered before cors and routes
app.use(expressModule.json({ limit: '25mb' }));
app.use(expressModule.urlencoded({ extended: true, limit: '25mb' }));

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

// un ejemplo de protección de nuestra api con un key o apiKey de ejemplo
app.get('/nueva-ruta', checkApiKey, (req, res) => {
  res.send('hola, soy tu nueva ruta');
});

routerApi(app);

// Create app_settings table if it doesn't exist (safe — does not alter existing tables)
const { AppSetting } = require('./db/models/appSettingModel');
AppSetting.sync({ force: false }).catch((err) =>
  console.error('[AppSetting] Error creando tabla app_settings:', err.message)
);

//Vamos a adicionar los middlewares de correccion de errores, hay que tener mucha delicadeza con el orden de definicion de los errores, el momento en que se los ejecuta, como una cadena
app.use(logErrors);
app.use(ormErrorHandler);
app.use(boomErrorHandler);
app.use(errorHandler);

const server = app.listen(puerto, '0.0.0.0', () => {
  console.log(`[OK] Server listening on 0.0.0.0:${puerto}`);
  console.log(`[OK] Start time: ${new Date().toISOString()}`);
});

server.on('error', (err) => {
  console.error('[FATAL] Server failed to bind:', err.message);
  process.exit(1);
});
