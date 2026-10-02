/**
 * Habitaciones — capa HTTP.
 * Logica y SQL en `services/habitacion.service.js`.
 */

const { success } = require("../utils/response");
const handle = require("../utils/handle");
const habitacionService = require("../services/habitacion.service");

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

module.exports = habitacionCtrl;
