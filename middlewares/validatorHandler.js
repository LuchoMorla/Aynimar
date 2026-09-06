const boom = require('@hapi/boom');

function validatorHandler(schema, property) {
    return (req, res, next) => {
        const data = req[property];
        const { error } = schema.validate(data, { abortEarly: false });
        if (error) {
            return next(boom.badRequest(error));
        }
        return next();
    }
}
module.exports = validatorHandler;