/**
 * Panel del hotel — capa HTTP.
 *
 * Este archivo ya no tiene SQL ni reglas de negocio: solo reparte los endpoints
 * del panel entre los services que corresponde.
 */

const { success } = require("../utils/response");
const handle = require("../utils/handle");
const dashboardService = require("../services/dashboard.service");
const historialService = require("../services/historial.service");

const adminCtrl = {};

adminCtrl.getDashboard = handle(async (_req, res) => {
  const datos = await dashboardService.obtener();
  return success(res, "Dashboard", datos);
});

adminCtrl.getHistorial = handle(async (req, res) => {
  const resultado = await historialService.listar(req.query);
  return success(res, "Historial de cambios", resultado);
});

module.exports = adminCtrl;
