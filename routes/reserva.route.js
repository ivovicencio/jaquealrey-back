const router = require("express").Router();
const reservaCtrl = require("../controllers/reserva.controller");
const { verifyToken } = require("../middlewares/auth.middleware");
const { validate } = require("../middlewares/validator");
const { reservaLimiter } = require("../middlewares/rateLimiter");

const createReservaSchema = [
  { name: "nombre", type: "string", required: true, minLength: 2 },
  { name: "telefono", type: "string", required: true, minLength: 6 },
  { name: "email", type: "email", required: true },
  { name: "habitacion_id", type: "number", required: true, min: 1 },
  { name: "fecha_entrada", type: "date", required: true },
  { name: "fecha_salida", type: "date", required: true },
  { name: "huespedes", type: "number", required: true, min: 1 },
];

router.post("/", reservaLimiter, validate(createReservaSchema), reservaCtrl.create);
router.get("/mis-reservas", verifyToken, reservaCtrl.getMisReservas);
router.get("/:id", verifyToken, reservaCtrl.getById);
router.put("/:id/cancelar", verifyToken, reservaCtrl.cancel);

module.exports = router;
