const { executeQuery, cache } = require("../db");
const { success, error } = require("../utils/response");

const habitacionCtrl = {};

habitacionCtrl.getAll = async (req, res, next) => {
  try {
    const { tipo, capacidad_min, precio_max, disponible_desde, disponible_hasta } = req.query;

    let query = "SELECT * FROM Habitacion WHERE activa = true";
    const params = [];
    let paramIndex = 1;

    if (tipo) {
      const tipos = Array.isArray(tipo) ? tipo : [tipo];
      const placeholders = tipos.map(() => `$${paramIndex++}`).join(", ");
      query += ` AND tipo IN (${placeholders})`;
      params.push(...tipos);
    }

    if (capacidad_min) {
      query += ` AND capacidad_max >= $${paramIndex++}`;
      params.push(parseInt(capacidad_min, 10));
    }

    if (precio_max) {
      query += ` AND precio_noche <= $${paramIndex++}`;
      params.push(parseFloat(precio_max));
    }

    // Si se pide disponibilidad por fechas, filtrar
    if (disponible_desde && disponible_hasta) {
      query += ` AND id = ANY(
        SELECT habitacion_id FROM habitaciones_disponibles_en_rango($${paramIndex++}, $${paramIndex++})
      )`;
      params.push(disponible_desde, disponible_hasta);
    } else if (disponible_desde || disponible_hasta) {
      return error(res, "Deben proporcionarse ambas fechas (desde y hasta) para filtrar disponibilidad", 400);
    }

    query += " ORDER BY numero";

    const result = await executeQuery(query, params, { role: "public" });
    return success(res, "Listado de habitaciones", result.rows);
  } catch (err) {
    next(err);
  }
};

habitacionCtrl.getById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await executeQuery("SELECT * FROM Habitacion WHERE id = $1 AND activa = true", [id], { role: "public" });

    if (result.rows.length === 0) {
      return error(res, "Habitación no encontrada", 404);
    }

    return success(res, "Detalle de habitación", result.rows[0]);
  } catch (err) {
    next(err);
  }
};

habitacionCtrl.getDisponibles = async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;

    if (!desde || !hasta) {
      return error(res, "Parámetros 'desde' y 'hasta' son requeridos (YYYY-MM-DD)", 400);
    }

    const result = await executeQuery(
      `SELECT h.* FROM Habitacion h
       WHERE h.activa = true
         AND h.id = ANY(SELECT habitacion_id FROM habitaciones_disponibles_en_rango($1, $2))
       ORDER BY h.numero`,
      [desde, hasta],
      { role: "public" }
    );

    return success(res, "Habitaciones disponibles", result.rows);
  } catch (err) {
    next(err);
  }
};

habitacionCtrl.create = async (req, res, next) => {
  try {
    const { numero, nombre, descripcion, camas_individuales, camas_matrimoniales, capacidad_max, tipo, precio_noche } = req.body;

    const result = await executeQuery(
      `INSERT INTO Habitacion (numero, nombre, descripcion, camas_individuales, camas_matrimoniales, capacidad_max, tipo, precio_noche)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [numero, nombre, descripcion, camas_individuales || 0, camas_matrimoniales || 0, capacidad_max, tipo, precio_noche],
      { role: "admin" }
    );

    await cache.invalidateAll();
    return success(res, "Habitación creada", result.rows[0], 201);
  } catch (err) {
    next(err);
  }
};

habitacionCtrl.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { numero, nombre, descripcion, camas_individuales, camas_matrimoniales, capacidad_max, tipo, precio_noche, activa } = req.body;

    const result = await executeQuery(
      `UPDATE Habitacion
       SET numero = COALESCE($1, numero),
           nombre = COALESCE($2, nombre),
           descripcion = COALESCE($3, descripcion),
           camas_individuales = COALESCE($4, camas_individuales),
           camas_matrimoniales = COALESCE($5, camas_matrimoniales),
           capacidad_max = COALESCE($6, capacidad_max),
           tipo = COALESCE($7, tipo),
           precio_noche = COALESCE($8, precio_noche),
           activa = COALESCE($9, activa)
       WHERE id = $10
       RETURNING *`,
      [numero, nombre, descripcion, camas_individuales, camas_matrimoniales, capacidad_max, tipo, precio_noche, activa, id],
      { role: "admin" }
    );

    if (result.rows.length === 0) {
      return error(res, "Habitación no encontrada", 404);
    }

    await cache.invalidateAll();
    return success(res, "Habitación actualizada", result.rows[0]);
  } catch (err) {
    next(err);
  }
};

habitacionCtrl.remove = async (req, res, next) => {
  try {
    const { id } = req.params;

    const hasReservas = await executeQuery(
      "SELECT id FROM Reserva WHERE habitacion_id = $1 AND estado IN ('Pendiente', 'Confirmada') LIMIT 1",
      [id],
      { role: "admin" }
    );

    if (hasReservas.rows.length > 0) {
      return error(res, "No se puede eliminar la habitación porque tiene reservas activas", 409);
    }

    const result = await executeQuery("DELETE FROM Habitacion WHERE id = $1 RETURNING *", [id], { role: "admin" });

    if (result.rows.length === 0) {
      return error(res, "Habitación no encontrada", 404);
    }

    await cache.invalidateAll();
    return success(res, "Habitación eliminada", result.rows[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = habitacionCtrl;
