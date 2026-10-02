/**
 * Reservas — capa HTTP.
 * Logica, transacciones y SQL en `services/reserva.service.js`.
 *
 * Nota sobre `ip`: los services la necesitan para la bitacora
 * (`HistorialReserva.ip_address`). `req.ip` detras de un proxy es la IP del
 * proxy, por eso la app configura `trust proxy` en app.js.
 */

const { success } = require("../utils/response");
const { AppError } = require("../utils/AppError");
const handle = require("../utils/handle");
const reservaService = require("../services/reserva.service");

const reservaCtrl = {};

const ipDe = (req) => req.ip || req.socket.remoteAddress;

reservaCtrl.consultar = handle(async (req, res) => {
  const codigo = String(req.query.codigo || "").trim();
  const email = String(req.query.email || "").trim();

  if (!codigo || !email) {
    throw new AppError("Debe indicar el codigo de reserva y el email", 400);
  }

  const reserva = await reservaService.consultarPorCodigo(codigo, email);
  return success(res, "Reserva encontrada", reserva);
});

reservaCtrl.cancelarPublica = handle(async (req, res) => {
  const { codigo, email, motivo } = req.body;
  const codigoLimpio = String(codigo || "").trim();
  const emailLimpio = String(email || "").trim();

  if (!codigoLimpio || !emailLimpio) {
    throw new AppError("Debe indicar el codigo de reserva y el email", 400);
  }

  const reserva = await reservaService.cancelarPorHuesped(
    { codigo: codigoLimpio, email: emailLimpio, motivo },
    ipDe(req)
  );

  return success(res, "Reserva cancelada", reserva);
});

reservaCtrl.reportarPago = handle(async (req, res) => {
  const { codigo, email } = req.body;
  const codigoLimpio = String(codigo || "").trim();
  const emailLimpio = String(email || "").trim();

  if (!codigoLimpio || !emailLimpio) {
    throw new AppError("Debe indicar el codigo de reserva y el email", 400);
  }

  const reserva = await reservaService.reportarPagoPorHuesped(
    { codigo: codigoLimpio, email: emailLimpio },
    ipDe(req)
  );

  return success(res, "Aviso de pago registrado", reserva);
});

reservaCtrl.create = handle(async (req, res) => {
  const reserva = await reservaService.crear(req.body, ipDe(req));
  return success(res, "Reserva creada exitosamente", reserva, 201);
});

// --- Admin ---

reservaCtrl.getById = handle(async (req, res) => {
  const reserva = await reservaService.obtenerPorId(req.params.id);
  return success(res, "Detalle de reserva", reserva);
});

reservaCtrl.getAll = handle(async (req, res) => {
  const { estado, desde, hasta, pagina, limite } = req.query;
  const resultado = await reservaService.listar({ estado, desde, hasta, pagina, limite });
  return success(res, "Listado de reservas", resultado);
});

reservaCtrl.updateEstado = handle(async (req, res) => {
  const { estado, notas } = req.body;
  const reserva = await reservaService.cambiarEstado(req.params.id, { estado, notas }, ipDe(req));
  return success(res, `Reserva ${estado.toLowerCase()}`, reserva);
});

module.exports = reservaCtrl;
