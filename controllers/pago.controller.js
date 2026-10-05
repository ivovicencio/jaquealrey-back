/**
 * Pagos y configuracion de cobro — capa HTTP.
 *
 * Sin try/catch: `handle` convierte los errores en la respuesta usando el mismo
 * criterio que el errorHandler (utils/errores.js). Logica, transacciones y SQL
 * en `services/pago.service.js` y `services/configuracion.service.js`.
 */

const { success } = require("../utils/response");
const handle = require("../utils/handle");
const pagoService = require("../services/pago.service");
const configuracionService = require("../services/configuracion.service");

const pagoCtrl = {};

const ipDe = (req) => req.ip || req.socket.remoteAddress;

// --- Publico: el huesped necesita el alias para transferir ---

pagoCtrl.getConfiguracionCobro = handle(async (_req, res) => {
  const config = await configuracionService.obtener();
  return success(res, "Datos para el pago", config);
});

// --- Panel del hotel ---

pagoCtrl.getConfiguracionCobroAdmin = handle(async (_req, res) => {
  const config = await configuracionService.obtenerAdmin();
  return success(res, "Datos privados de cobro", config);
});

pagoCtrl.updateConfiguracionCobro = handle(async (req, res) => {
  const actualizada = await configuracionService.actualizar(req.body);
  return success(res, "Configuracion actualizada", actualizada);
});

pagoCtrl.getPagosReserva = handle(async (req, res) => {
  const resultado = await pagoService.obtenerPorReserva(req.params.id);
  return success(res, "Pagos de la reserva", resultado);
});

pagoCtrl.getPagos = handle(async (req, res) => {
  const resultado = await pagoService.listar(req.query);
  return success(res, "Listado de pagos", resultado);
});

pagoCtrl.createPago = handle(async (req, res) => {
  const pago = await pagoService.crear(req.body, ipDe(req));
  return success(res, "Pago registrado", pago);
});

pagoCtrl.updatePagoEstado = handle(async (req, res) => {
  const { estado, referencia, fecha_pago, notas } = req.body;
  const pago = await pagoService.cambiarEstado(
    req.params.id,
    { estado, referencia, fecha_pago, notas },
    ipDe(req)
  );
  return success(res, "Pago actualizado", pago);
});

pagoCtrl.getIngresos = handle(async (req, res) => {
  const resultado = await pagoService.ingresos({ desde: req.query.desde });
  return success(res, "Ingresos", resultado);
});

module.exports = pagoCtrl;
