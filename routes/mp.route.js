const router = require("express").Router();
const mpCtrl = require("../controllers/mp.controller");
const { verifyAdminToken } = require("../middlewares/auth.middleware");
const { reservaLimiter } = require("../middlewares/rateLimiter");

// verifyAdminToken y no verifyToken: la preferencia de pago se arma sobre una
// reserva que el cuerpo elige por id, asi que con solo "estas autenticado"
// cualquier usuario autenticado podria generar el pago de la reserva ajena.
router.post("/crear-preferencia", verifyAdminToken, reservaLimiter, mpCtrl.createPreference);
router.post("/webhook", mpCtrl.webhook);
router.get("/success", mpCtrl.success);
router.get("/pending", mpCtrl.pending);
router.get("/failure", mpCtrl.failure);

module.exports = router;
