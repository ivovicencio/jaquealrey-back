/**
 * Habitaciones — capa HTTP.
 * Logica y SQL en `services/habitacion.service.js`.
 */

const { success } = require("../utils/response");
const handle = require("../utils/handle");
const habitacionService = require("../services/habitacion.service");

// Va en el bitácora de la habitación, así que hace falta la IP real del que
// tocó el botón. Mismo criterio que en reserva.controller.js.
const ipDe = (req) => req.ip || req.socket.remoteAddress;

const habitacionCtrl = {};

habitacionCtrl.getAll = handle(async (req, res) => {
  const { tipo, capacidad_min, precio_max, disponible_desde, disponible_hasta } = req.query;

  const habitaciones = await habitacionService.listarPublico({
    tipo,
    capacidad_min,
    precio_max,
    disponible_desde,
    disponible_hasta,
  });

  return success(res, "Listado de habitaciones", habitaciones);
});

habitacionCtrl.getById = handle(async (req, res) => {
  const habitacion = await habitacionService.obtenerPublico(req.params.id);
  return success(res, "Detalle de habitacion", habitacion);
});

habitacionCtrl.getDisponibles = handle(async (req, res) => {
  const { desde, hasta } = req.query;
  const habitaciones = await habitacionService.listarDisponibles(desde, hasta);
  return success(res, "Habitaciones disponibles", habitaciones);
});

habitacionCtrl.create = handle(async (req, res) => {
  const habitacion = await habitacionService.crear(req.body);
  return success(res, "Habitacion creada", habitacion, 201);
});

habitacionCtrl.update = handle(async (req, res) => {
  const habitacion = await habitacionService.actualizar(req.params.id, req.body);
  return success(res, "Habitacion actualizada", habitacion);
});

habitacionCtrl.remove = handle(async (req, res) => {
  const habitacion = await habitacionService.eliminar(req.params.id);
  return success(res, "Habitacion eliminada", habitacion);
});

habitacionCtrl.reactivar = handle(async (req, res) => {
  const habitacion = await habitacionService.reactivar(req.params.id, ipDe(req));
  return success(res, "Habitacion de vuelta al mercado", habitacion);
});

habitacionCtrl.listarEstado = handle(async (req, res) => {
  const habitaciones = await habitacionService.listarEstadoOperativo();
  return success(res, "Estado de las habitaciones", habitaciones);
});

habitacionCtrl.updateEstado = handle(async (req, res) => {
  const habitacion = await habitacionService.actualizarEstadoOperativo(
    req.params.id,
    req.body,
    ipDe(req)
  );
  return success(res, "Estado de la habitacion actualizado", habitacion);
});

habitacionCtrl.listarBloqueos = handle(async (req, res) => {
  const { habitacion_id, solo_vigentes } = req.query;
  const bloqueos = await habitacionService.listarBloqueos({
    habitacion_id: habitacion_id ? parseInt(habitacion_id, 10) : undefined,
    solo_vigentes: solo_vigentes === "true" || solo_vigentes === "1",
  });
  return success(res, "Bloqueos de habitaciones", bloqueos);
});

habitacionCtrl.crearBloqueo = handle(async (req, res) => {
  const bloqueo = await habitacionService.crearBloqueo(req.body, ipDe(req));
  return success(res, "Habitacion bloqueada", bloqueo, 201);
});

habitacionCtrl.levantarBloqueo = handle(async (req, res) => {
  const bloqueo = await habitacionService.levantarBloqueo(req.params.id, ipDe(req));
  return success(res, "Bloqueo levantado", bloqueo);
});

module.exports = habitacionCtrl;
