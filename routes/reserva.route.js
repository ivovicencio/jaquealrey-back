const router = require("express").Router();
const reservaCtrl = require("../controllers/reserva.controller");
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

const consultarSchema = [
  { name: "codigo", type: "string", required: true, minLength: 4 },
  { name: "email", type: "email", required: true },
];

const cancelarSchema = [
  { name: "codigo", type: "string", required: true, minLength: 4 },
  { name: "email", type: "email", required: true },
];

// El huesped no tiene cuenta: se identifica con codigo + email.
// El GET valida contra req.query, el PUT contra req.body.
router.get(
  "/consultar",
  reservaLimiter,
  validate(consultarSchema, "query"),
  reservaCtrl.consultar
);
router.put("/cancelar", reservaLimiter, validate(cancelarSchema), reservaCtrl.cancelarPublica);

router.post("/", reservaLimiter, validate(createReservaSchema), reservaCtrl.create);

module.exports = router;
