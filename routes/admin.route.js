/**
 * Rutas del panel del hotel.
 *
 * Todas pasan por `adminGuard` (autenticado + admin + rate limit estricto).
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
    enum: ["Pendiente", "Confirmada", "En_Casa", "Cancelada", "Completada"],
  },
  { name: "notas", type: "string", maxLength: 500 },
  // Override deliberado de la regla de anticipo (reserva.service.js). Va
  // aparte del estado a proposito: confirmar sin plata tiene que ser una
  // decision consciente del recepcionista, no un efecto secundario de
  // cambiar el estado. Queda en la bitacora como "(forzado sin pago)".
  { name: "forzar_sin_pago", type: "boolean" },
];

const walkInSchema = [
  { name: "nombre", type: "string", required: true, minLength: 2 },
  { name: "apellido", type: "string", minLength: 1 },
  { name: "telefono", type: "string", required: true, minLength: 6 },
  { name: "email", type: "email", required: true },
  // Documento y nacionalidad se piden en el check-in, no acá (PASOS.md 24.2).
  // Ver el comentario de checkInSchema: en recepción el DNI está a la vista.
  { name: "habitacion_id", type: "number", required: true, min: 1 },
  { name: "fecha_entrada", type: "date", required: true },
  { name: "fecha_salida", type: "date", required: true },
  { name: "huespedes", type: "number", required: true, min: 1 },
  { name: "notas", type: "string" },
];

/**
 * Check-in. Documento y nacionalidad son requeridos acá y NO en el formulario
 * web (PASOS.md 24.1 y 24.2).
 *
 * En recepción el DNI ya está a la vista, así que pedirlo no cuesta nada. En la
 * web, pedir DNI a alguien parado en la ruta a las 23:00 con Cellular cuesta la
 * reserva, y no hace falta para reservar: eso se pide recién en el check-in.
 */
const checkInSchema = [
  { name: "documento", type: "string", required: true, minLength: 6, maxLength: 30 },
  { name: "nacionalidad", type: "string", required: true, minLength: 2, maxLength: 60 },
  { name: "entregado_a", type: "string", maxLength: 150 },
  { name: "notas", type: "string", maxLength: 500 },
  { name: "forzar_sin_pago", type: "boolean" },
];

// El check-out no pide nada obligatorio: puede no haber notas. El saldo lo
// calcula el service y, si debe plata, el 409 lo dice con el monto.
const checkOutSchema = [
  { name: "notas", type: "string", maxLength: 500 },
  // Cierra la cuenta con saldo impago. Queda en la bitácora como
  // "Saldo impago: $X (forzado)".
  { name: "forzar_sin_pago", type: "boolean" },
];

// 'ocupada' no está en el enum a propósito: el service la rechaza con un
// mensaje que explica por qué. Si estuviera en el enum, el 400 del validator
// sería genérico y el recepcionista no sabría que tiene que usar el check-in.
const estadoOperativoSchema = [
  { name: "estado_operativo", type: "string", required: true, enum: ["libre", "limpieza", "mantenimiento"] },
];

const bloqueoSchema = [
  { name: "habitacion_id", type: "number", required: true, min: 1 },
  { name: "desde", type: "date", required: true },
  { name: "hasta", type: "date", required: true },
  // Sin motivo, el bloqueo no se puede justificar después. Es NOT NULL en la
  // tabla justamente por esto.
  { name: "motivo", type: "string", required: true, minLength: 3, maxLength: 200 },
];

// --- Dashboard y bitácora ---
router.get("/dashboard", ...adminGuard, adminCtrl.getDashboard);
router.get("/historial", ...adminGuard, adminCtrl.getHistorial);

// --- Pantalla del día (recepción) ---
router.get("/hoy", ...adminGuard, reservaCtrl.getHoy);

// --- Reservas ---
// El orden importa: "/reservas/por-verificar" va antes de "/reservas/:id" o
// Express matchea el :id con la palabra "por-verificar" y el endpoint real queda
// inalcanzable. Por eso no se puede usar un router de parametros acá.
router.get("/reservas", ...adminGuard, reservaCtrl.getAll);
router.get("/reservas/por-verificar", ...adminGuard, reservaCtrl.getPorVerificar);
router.get("/reservas/:id", ...adminGuard, reservaCtrl.getById);
router.post("/reservas", ...adminGuard, validate(walkInSchema), reservaCtrl.createWalkIn);
router.put(
  "/reservas/:id/estado",
  ...adminGuard,
  validate(updateReservaSchema),
  reservaCtrl.updateEstado
);

// Recepción. Rutas separadas y no un PUT /estado con un estado más: cada una
// tiene su propio cuerpo y sus propias reglas (identidad en el check-in, saldo en
// el check-out), y el dropdown genérico de estados es justo lo que dejó que un
// admin pusiera En_Casa sin tocar la habitación (PASOS.md 23.3).
router.post(
  "/reservas/:id/check-in",
  ...adminGuard,
  validate(checkInSchema),
  reservaCtrl.checkIn
);
router.post(
  "/reservas/:id/check-out",
  ...adminGuard,
  validate(checkOutSchema),
  reservaCtrl.checkOut
);
router.post("/reservas/:id/no-se-presento", ...adminGuard, reservaCtrl.noShow);

// --- Calendario ---
router.get("/ocupacion", ...adminGuard, ocupacionCtrl.getOcupacion);

// --- Habitaciones ---
router.post("/habitaciones", ...adminGuard, validate(habitacionSchema), habitacionCtrl.create);
router.put("/habitaciones/:id", ...adminGuard, habitacionCtrl.update);
router.delete("/habitaciones/:id", ...adminGuard, habitacionCtrl.remove);

// Estado operativo, para la pantalla de recepción. La lista va antes que
// "/habitaciones/:id" por lo mismo que "/reservas/por-verificar": sin esto,
// Express matchea ":id" con "estado" y la ruta real queda muerta.
router.get("/habitaciones/estado", ...adminGuard, habitacionCtrl.listarEstado);
router.put(
  "/habitaciones/:id/estado",
  ...adminGuard,
  validate(estadoOperativoSchema),
  habitacionCtrl.updateEstado
);

// "Limpieza terminada": la habitacion vuelve de 'limpieza' a 'libre'. Paso
// explicito, nunca automatico despues del check-out (PASOS.md 22.3).
router.post("/habitaciones/:id/reactivar", ...adminGuard, habitacionCtrl.reactivar);

// --- Bloqueos ---
// Un bloqueo saca la habitacion de la venta durante un rango de fechas.
router.get("/bloqueos", ...adminGuard, habitacionCtrl.listarBloqueos);
router.post("/bloqueos", ...adminGuard, validate(bloqueoSchema), habitacionCtrl.crearBloqueo);
router.delete("/bloqueos/:id", ...adminGuard, habitacionCtrl.levantarBloqueo);

module.exports = router;