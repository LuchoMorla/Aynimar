const expressModule = require('express');
const router = expressModule.Router();

router.get('/:categoryId/productos/:productosId', (req, res) => {
    const { categoryId, productosId } = req.params;
    res.json({
        categoryId,
        productosId,
    });
})

module.exports = router;
