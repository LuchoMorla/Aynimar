const expressModule = require('express');
const routerApi = require('./routes');
const cors = require('cors');
const { checkApiKey } = require('./middlewares/authHandler');
const multer = require('multer')
const path = require("path")

//Los middlewares del tipo error se deben crear despues de establecer el routing de nuestra aplicacion
const { logErrors, errorHandler, boomErrorHandler, ormErrorHandler } = require('./middlewares/errorsHandler');

const app = expressModule();

const puerto = process.env.PORT || 8080;

// implementamos el middleware nativo de express para exportar archivos en formato json
app.use(expressModule.json());
app.use(expressModule.static("uploads"))

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, './uploads'); // Directory where files will be stored
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname)); // File name will be timestamp + extension
    }
});

const upload = multer({ storage })

// implementando CORS para los dominios
const whitelist = [
    'https://aynimar.vercel.app', 'https://www.aynimar.com', 'https://aynimar.com',
    'http://aynimar.vercel.app', 'http://www.aynimar.com', 'http://aynimar.com', 'https://aynimar-luchomorla.vercel.app/'
];
const options = {
    origin: (origin, callback) => {
        if (whitelist.includes(origin) || !origin) {
            callback(null, true);
        } else {
            callback(new Error('No permitidation, dont do it agai, no!'));
        };
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],  // Especifica los métodos HTTP permitidos
    allowedHeaders: ['Content-Type', 'Authorization'] // Especifica los encabezados permitidos
};
/*  //comente para que aceptara cualquier tipo de dominio o dirección IP 'http://localhost:8080/frontend.html', 'http://localhost:8080/products', 
'http://localhost:8080','http://localhost:3000/',
'http://localhost:3000/recycling',  */
if (process.env.NODE_ENV === 'production') {
    app.use(cors(options));
} else {
    app.use(cors());
}
/* app.use(cors()); */
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

app.post("/api/v1/products/upload", upload.array('images', 5) ,async(req, res)=>{
    try {
        const files = req.files;
        if (!files || files.length === 0) {
          return res.status(400).send('No files uploaded.');
        }
        // Array to store file URLs
        const fileUrls = [];
        // Generate URLs for each uploaded file
        files.forEach(file => {
          const fileUrl = path.join("uploads", file.filename);
          fileUrls.push(fileUrl);
        });
        res.json(fileUrls[0]);
        // res.sendFile(fileUrls[0])

    } catch (error) {
        res.send({"error": "Unable to upload image"})
    }
})

app.get("/uploads/:id", async(req, res)=>{
    const {id} = req.params
    try {
        const imagePath = path.join(__dirname, "uploads", id)
        res.sendFile(imagePath)
        // res.sendFile(fileUrls[0])

    } catch (error) {
        res.send({"error": "Unable to upload image"})
    }
})

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