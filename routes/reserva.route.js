const router = require("express").Router();
const reservaCtrl = require("../controllers/reserva.controller");
const { validate } = require("../middlewares/validator");
const { reservaLimiter, reservaEmailLimiter } = require("../middlewares/rateLimiter");

const createReservaSchema = [
  { name: "nombre", type: "string", required: true, minLength: 2 },
  { name: "telefono", type: "string", required: true, minLength: 6 },
  { name: "email", type: "email", required: true },
  { name: "habitacion_id", type: "number", required: true, min: 1 },
  { name: "fecha_entrada", type: "date", required: true },
  { name: "fecha_salida", type: "date", required: true },
  { name: "huespedes", type: "number", required: true, min: 1 },

  // Aceptación de términos, exigida por el service (PASOS.md 24.5).
  //
  // `required` NO obliga a que sea `true`: solo a que el campo esté presente.
  // Necesario, porque `false` es una respuesta válida del usuario y el mensaje
  // "es requerido" sería el equivocado; el que dice "tenés que aceptar los
  // términos" lo tira reserva.service.js, que sí mira el valor.
  { name: "acepta_terminos", type: "boolean", required: true },
  { name: "terminos_version", type: "string", required: true, maxLength: 20 },
];

const reportarPagoSchema = [
  { name: "codigo", type: "string", required: true, minLength: 4 },
  { name: "email", type: "email", required: true },
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
//
// Los cuatro endpoints llevan los mismos dos limitadores (IP + email). El de
// email no es por crear reservas: /consultar y /cancelar devuelven la reserva
// o la cancelan solo con codigo + email, asi que son exactamente las rutas que
// un atacante usa para adivinar credenciales ajenas. Sin el limite por email,
// el de IP solo frena el volumen bruto de una conexion, y el atacante rota de
// IP trivialmente.
//
// El de email va DESPUES del de IP para que el mensaje que ve el huesped sea el
// del limite de IP, que es el que explica la espera de 15 minutos.
router.get(
  "/consultar",
  reservaLimiter,
  reservaEmailLimiter,
  validate(consultarSchema, "query"),
  reservaCtrl.consultar
);
router.put(
  "/cancelar",
  reservaLimiter,
  reservaEmailLimiter,
  validate(cancelarSchema),
  reservaCtrl.cancelarPublica
);

// Aviso de "ya transferi". Mismo criterio que cancelar: codigo + email, sin
// cuenta. Mismo limitador de IP y de email, porque es la misma clase de trafico
// (el mismo huesped puede reintentar si le dio timeout) y no tiene sentido que
// uno este limitado y el otro no.
router.put(
  "/reportar-pago",
  reservaLimiter,
  reservaEmailLimiter,
  validate(reportarPagoSchema),
  reservaCtrl.reportarPago
);

// Dos limitadores y no uno, a proposito:
//   - por IP, para el volumen bruto de una conexion;
//   - por email, que es lo que de verdad frena la reserva-bomba y no castiga
//     a los huespedes que comparten la IP del wifi del hotel.
router.post("/", reservaLimiter, reservaEmailLimiter, validate(createReservaSchema), reservaCtrl.create);

module.exports = router;
