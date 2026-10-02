/**
 * Rutas del panel del hotel.
 *
 * Todas pasan por `adminGuard` (autenticado + admin + rate limit estricto). Se
 * repite el guard en cada ruta a proposito: un `router.use(adminGuard)` al tope
 * queda a una linea de quedar sin cubrir al agregar una ruta nueva, y ahi aparece
 * un endpoint de admin accesible sin sesion.
 */

const router = require("express").Router();

const adminCtrl = require("../controllers/admin.controller");
const habitacionCtrl = require("../controllers/habitacion.controller");
const reservaCtrl = require("../controllers/reserva.controller");
const ocupacionCtrl = require("../controllers/ocupacion.controller");

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
  {
    name: "estado",
    type: "string",
    required: true,
    enum: ["Pendiente", "Confirmada", "Cancelada", "Completada"],
  },
];

// --- Dashboard y bitacora ---
router.get("/dashboard", ...adminGuard, adminCtrl.getDashboard);
router.get("/historial", ...adminGuard, adminCtrl.getHistorial);

// --- Reservas ---
router.get("/reservas", ...adminGuard, reservaCtrl.getAll);
router.get("/reservas/:id", ...adminGuard, reservaCtrl.getById);
router.put(
  "/reservas/:id/estado",
  ...adminGuard,
  validate(updateReservaSchema),
  reservaCtrl.updateEstado
);

// --- Calendario ---
router.get("/ocupacion", ...adminGuard, ocupacionCtrl.getOcupacion);

// --- Habitaciones ---
router.post("/habitaciones", ...adminGuard, validate(habitacionSchema), habitacionCtrl.create);
router.put("/habitaciones/:id", ...adminGuard, habitacionCtrl.update);
router.delete("/habitaciones/:id", ...adminGuard, habitacionCtrl.remove);

module.exports = router;
