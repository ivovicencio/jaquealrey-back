/**
 * Datos del hotel.
 *
 * Es una tabla de una sola fila (el hotel), asi que no hay id que buscar: siempre
 * la misma. La cache entra porque esta info cambia una vez por temporada y se
 * pide en cada carga de la pagina publica.
 */

const { executeQuery, cache, ROL } = require("../db");
const { AppError } = require("../utils/AppError");

// Columnas explicitas a proposito, por el mismo motivo que en el catalogo: un
// SELECT * aca filtraria sola cualquier columna interna que se agregue a Hotel en
// el futuro (notas internas, cuentas, etc).
const PUBLIC_COLUMNS = "id, nombre, direccion, telefono, email, descripcion, created_at";

const CACHE_KEY = () => cache.key("hotel", "info");

/** Info del hotel para el sitio publico. Cacheada. */
async function obtener() {
  const cached = await cache.get(CACHE_KEY());
  if (cached) return JSON.parse(cached);

  const result = await executeQuery(`SELECT ${PUBLIC_COLUMNS} FROM Hotel LIMIT 1`, [], ROL.PUBLICO);
  const hotel = result.rows[0];

  if (!hotel) throw new AppError("No hay informacion del hotel", 404);

  await cache.set(CACHE_KEY(), JSON.stringify(hotel));
  return hotel;
}

/**
 * Actualiza los datos del hotel (solo admin).
 *
 * COALESCE en cada columna: el panel manda solo los campos que edito y el resto
 * tiene que quedar como estaba.
 */
async function actualizar({ nombre, direccion, telefono, email, descripcion }) {
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
    ROL.ADMIN
  );

  // Se invalida la cache recien despues del write, no antes: si el UPDATE falla,
  // la version cacheada sigue siendo la correcta.
  await cache.del(CACHE_KEY());
  return result.rows[0];
}

module.exports = { obtener, actualizar, PUBLIC_COLUMNS };
