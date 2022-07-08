const expressModule = require('express');
//const faker = require('faker');
const ProductsService = require('./../Services/productServices');

const validatorHandler = require('../middlewares/validatorHandler');
const { createProductSchema, updateProductSchema, getProductSchema } = require('../schemaODtos/productSchema');

const router = expressModule.Router();

//Como es una clase, creamos una instancia del servicio:
const service = new ProductsService();

router.get('/', async (req, res, next) => {
    try {
        const products = await service.find();
        res.json(products);
    } catch (error) {
        next(error);
    }
});

/* Esto lo llevaremos a la capa de servicios por que es aprte de la logica de negocio más no es parte del routing
//Utilizaremos faker para poblar de informacion más consisa a un catalogo de productos
router.get('/', (req, res) => {
    const products = [];
    const { size } = req.query;
    const limit = size || 10;
    for (let index = 0; index < limit; index++) {
        products.push({
            name: faker.commerce.productName(),
            price: parseInt(faker.commerce.price(), 10),
            image: faker.image.imageUrl(),
        });
    }
    res.json(products);
    });
*/

//ejemplo para que no haya confusion en evitar errores

router.get('/filter', (req, res) => {
    res.send('Yo soy un filter');
  });

  /*   Vamos a manejar esto ahora de una forma diferente, una más inteligente.
    const { id } = req.params;
    if(id === '999') {
        res.status(404).json({
            message: 'not found'
        });
    } else {
        res.status(200).json({
            id,
            name: 'Product 2',
            price: 2000
        });
    } */
    
router.get('/:id', 
    validatorHandler(getProductSchema, 'params'),
    async (req, res, next) => {
        try {
            const { id } = req.params;
            const product = await service.findOne(id);
            res.json(product);
        } catch (error) {
            next(error);
        }
});

// Metodo Post:

router.post('/',
    validatorHandler(createProductSchema, 'body'),
    async (req, res) => {
        const body = req.body;
        const newProduct = await service.create(body);
        res.status(201).json(newProduct);
/*     res.status(201).json({
        message: 'created',
        data: body
    }); */
});

// Metodo patch para los update, podriamos hacer lo mismo con put pero nos vamos a quedar con patch
router.patch('/:id', 
    validatorHandler(getProductSchema, 'params'),
    validatorHandler(updateProductSchema, 'body'),
    async (req, res) => {
        try {
        const { id } = req.params;
        const body = req.body;
        const product = await service.update(id, body);
        res.json(product);
        /*     res.json({
            message: 'Update',
            data: body,
            id,
        }); */
    } catch {
        next(error);
/*     res.status(404).json({
        message: error.message
    }); */
}
});

// Metodo delete para los update, podriamos hacer lo mismo con put pero nos vamos a quedar con patch
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const respuesta = await service.delete(id);
    res.json(respuesta);
/*     res.json({
        message: 'Deleted',
        id,
    }); */
});


    module.exports = router;