const router = require("express").Router();
const pagoCtrl = require("../controllers/pago.controller");
const { verifyToken, verifyAdmin } = require("../middlewares/auth.middleware");
const { adminLimiter } = require("../middlewares/rateLimiter");

const adminGuard = [verifyToken, verifyAdmin, adminLimiter];

// Publico: el huesped necesita el alias para transferir.
router.get("/configuracion", pagoCtrl.getConfiguracionCobro);

// Todo lo demas es del panel del hotel.
router.get("/", ...adminGuard, pagoCtrl.getPagos);
router.get("/ingresos", ...adminGuard, pagoCtrl.getIngresos);
router.post("/", ...adminGuard, pagoCtrl.createPago);
router.put("/configuracion", ...adminGuard, pagoCtrl.updateConfiguracionCobro);
router.put("/:id/estado", ...adminGuard, pagoCtrl.updatePagoEstado);
router.get("/reserva/:id", ...adminGuard, pagoCtrl.getPagosReserva);

module.exports = router;