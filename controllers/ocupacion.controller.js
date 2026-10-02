/**
 * Ocupacion (calendario del panel) — capa HTTP.
 * Logica en `services/ocupacion.service.js`.
 */

const { success } = require("../utils/response");
const handle = require("../utils/handle");
const ocupacionService = require("../services/ocupacion.service");

const ocupacionCtrl = {};

ocupacionCtrl.getOcupacion = handle(async (req, res) => {
  const { desde, hasta } = req.query;
  const resultado = await ocupacionService.obtener(desde, hasta);
  return success(res, "Ocupacion", resultado);
});

module.exports = ocupacionCtrl;
