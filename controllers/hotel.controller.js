const { executeQuery, cache } = require("../db");
const { success, error } = require("../utils/response");

const hotelCtrl = {};

hotelCtrl.getHotel = async (_req, res, next) => {
  try {
    const cached = await cache.get(cache.key("hotel", "info"));
    if (cached) {
      return success(res, "Información del hotel", JSON.parse(cached));
    }

    const result = await executeQuery("SELECT * FROM Hotel LIMIT 1", []);
    const hotel = result.rows[0];

    if (!hotel) {
      return error(res, "No hay información del hotel", 404);
    }

    await cache.set(cache.key("hotel", "info"), JSON.stringify(hotel));
    return success(res, "Información del hotel", hotel);
  } catch (err) {
    next(err);
  }
};

hotelCtrl.updateHotel = async (req, res, next) => {
  try {
    const { nombre, direccion, telefono, email, descripcion } = req.body;
    const result = await executeQuery(
      `UPDATE Hotel
       SET nombre = COALESCE($1, nombre),
           direccion = COALESCE($2, direccion),
           telefono = COALESCE($3, telefono),
           email = COALESCE($4, email),
           descripcion = COALESCE($5, descripcion)
       WHERE id = 1
       RETURNING *`,
      [nombre, direccion, telefono, email, descripcion],
      { role: "admin" }
    );

    await cache.del(cache.key("hotel", "info"));
    return success(res, "Hotel actualizado", result.rows[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = hotelCtrl;
