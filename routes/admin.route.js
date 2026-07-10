const router = require("express").Router();
const adminCtrl = require("../controllers/admin.controller");
const habitacionCtrl = require("../controllers/habitacion.controller");
const { verifyToken, verifyAdmin } = require("../middlewares/auth.middleware");
const { validate } = require("../middlewares/validator");
const { adminLimiter } = require("../middlewares/rateLimiter");

const adminGuard = [verifyToken, verifyAdmin, adminLimiter];

const habitacionSchema = [
  { name: "numero", type: "number", required: true, min: 1 },
  { name: "nombre", type: "string", required: true, minLength: 2 },
  { name: "capacidad_max", type: "number", required: true, min: 1 },
  { name: "tipo", type: "string", required: true, enum: ["Doble", "Triple", "Cuádruple"] },
  { name: "precio_noche", type: "number", required: true, min: 1 },
];

const updateReservaSchema = [
  { name: "estado", type: "string", required: true, enum: ["Pendiente", "Confirmada", "Cancelada", "Completada"] },
];

router.get("/dashboard", ...adminGuard, adminCtrl.getDashboard);
router.get("/reservas", ...adminGuard, adminCtrl.getReservas);
router.get("/reservas/:id", ...adminGuard, adminCtrl.getReservas);
router.put("/reservas/:id/estado", ...adminGuard, validate(updateReservaSchema), adminCtrl.updateReservaEstado);
router.get("/clientes", ...adminGuard, adminCtrl.getClientes);
router.get("/clientes/:id", ...adminGuard, adminCtrl.getClienteById);
router.get("/historial", ...adminGuard, adminCtrl.getHistorial);

router.post("/habitaciones", ...adminGuard, validate(habitacionSchema), habitacionCtrl.create);
router.put("/habitaciones/:id", ...adminGuard, habitacionCtrl.update);
router.delete("/habitaciones/:id", ...adminGuard, habitacionCtrl.remove);

module.exports = router;
