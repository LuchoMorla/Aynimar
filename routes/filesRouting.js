const { Router } = require("express");
const passport = require("passport");
const path = require("path");
const { checkRoles } = require("../middlewares/authHandler");
const { FileService } = require("../Services/fileService");
const multer = require('multer');
const upload = multer()

const uploadRouter = new Router();
const fileService = new FileService();

uploadRouter.post('/upload', passport.authenticate('jwt', { session: false }),
  checkRoles('admin', 'business_owner'), upload.single('img'), async (req, res, next) => {
    try {
      const { file } = req;

      const data = await fileService.uploadFile(file);

      res.status(200).json({
        message: 'Archivo subido correctamente',
        file: {
          url: `https://drive.google.com/thumbnail?id=${data.id}&sz=w500`
        }
      });
    } catch (err) {
      next(err);
    }
  })

uploadRouter.get('/download/:fileName', async (req, res, next) => {
  const { fileName } = req.params;

  res.download(path.join(__dirname, `../uploads/${fileName}`), (err) => {
    if (err) return next(err);
  });
});

module.exports = uploadRouter