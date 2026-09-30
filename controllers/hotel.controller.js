const { executeQuery, cache } = require("../db");
const { success, error } = require("../utils/response");

// GET /api/hotel es publico. Columnas explicitas a proposito, por el mismo motivo
// que en el catalogo: un SELECT * aca filtraria sola cualquier columna interna
// que se agregue a Hotel en el futuro (notas internas, cuentas, etc).
const PUBLIC_COLUMNS = "id, nombre, direccion, telefono, email, descripcion, created_at";

const hotelCtrl = {};

hotelCtrl.getHotel = async (_req, res, next) => {
  try {
    const cached = await cache.get(cache.key("hotel", "info"));
    if (cached) {
      return success(res, "Información del hotel", JSON.parse(cached));
    }

    const result = await executeQuery(`SELECT ${PUBLIC_COLUMNS} FROM Hotel LIMIT 1`, []);
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
