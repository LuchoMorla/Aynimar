const { Router } = require("express");
const passport = require("passport");
const path = require("path");
const { checkRoles } = require("../middlewares/authHandler");

const uploadRouter = new Router();

uploadRouter.post('/upload', passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'), (req, res, next) => {
    const { files } = req;

    files.img.mv(path.join(__dirname, `../uploads/${files.img.name}`), (err) => {
      if (err) return next(err);
      const url = `${req.protocol}://${req.get('host')}/api/v1/files/download/${files.img.name}`;

      res.status(200).json({
        message: 'Archivo subido correctamente',
        file: {
          url,
          name: files.img.name,
          mimetype: files.img.mimetype,
          size: files.img.size
        }
      });
    });
  })

uploadRouter.get('/download/:fileName', (req, res, next) => {
  const { fileName } = req.params;
  res.download(path.join(__dirname, `../uploads/${fileName}`), (err) => {
    if (err) return next(err);
  }
  );
});

module.exports = uploadRouter