/**
 * Hotel — capa HTTP.
 * Logica en `services/hotel.service.js`.
 */

const { success } = require("../utils/response");
const handle = require("../utils/handle");
const hotelService = require("../services/hotel.service");

const hotelCtrl = {};

hotelCtrl.getHotel = handle(async (_req, res) => {
  const hotel = await hotelService.obtener();
  return success(res, "Informacion del hotel", hotel);
});

hotelCtrl.updateHotel = handle(async (req, res) => {
  const { nombre, direccion, telefono, email, descripcion } = req.body;
  const hotel = await hotelService.actualizar({ nombre, direccion, telefono, email, descripcion });
  return success(res, "Hotel actualizado", hotel);
});

module.exports = hotelCtrl;
