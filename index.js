const expressModule = require('express');
const routerApi = require('./routes');
const cors = require('cors');
const { checkApiKey } = require('./middlewares/authHandler');

//Los middlewares del tipo error se deben crear despues de establecer el routing de nuestra aplicacion
const { logErrors, errorHandler, boomErrorHandler, sqlQueryErrorHandler, ormErrorHandler } = require('./middlewares/errorsHandler');

const app = expressModule();

const puerto = process.env.PORT || 8080;

// implementamos el middleware nativo de express para exportar archivos en formato json
app.use(expressModule.json());

// implementando CORS para los dominios
/* const whitelist = ['http://localhost:8080/frontend.html', 'http://localhost:8080/products',
 'http://localhost:8080','http://localhost:3000/',
 'http://localhost:3000/recycling', 'http://192.168.1.6:3000', 'http://172.17.160.1:3000', 'http://192.168.56.1:3000'];
const options = {
    origin: (origin, callback) => {
        if (whitelist.includes(origin) || !origin) {
            callback(null, true);
        } else {
            callback(new Error('No permitidation, dont do it againo!'));
        }
    }
} lo deshabilite para que acepte cualquier dominio*/
app.use(cors());

//importare el index.js de auth para los login
require('./utils/auth');

//administracion de primeras rutas

app.get('/', (req, res) => {
    res.send('Hola mi server en express </br> <a href="http://localhost:8080/api/v1/products">link productos</a>');
});

// un ejemplo de protección de nuestra api con un key o apiKey de ejemplo
app.get('/nueva-ruta', checkApiKey, (req, res) =>{
    res.send('hola, soy tu nueva ruta');
});

routerApi(app);

//Vamos a adicionar los middlewares de correccion de errores, hay que tener mucha delicadeza con el orden de definicion de los errores, el momento en que se los ejecuta, como una cadena
app.use(logErrors);
app.use(ormErrorHandler);
app.use(boomErrorHandler);
app.use(errorHandler);


app.listen(puerto, () => {
    console.log('Mi port is ' + puerto)
    console.log(`listening at http://localhost:${puerto}`)
    console.log(new Date)
/*     lo que es lo mismo que:
    console.log("lestening at http://localhost:" + puerto) */
});