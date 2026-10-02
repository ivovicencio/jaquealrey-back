/**
 * Habitaciones: catalogo publico y administracion.
 *
 * El SQL vive aca. El controller solo traduce HTTP.
 */

const { executeQuery, cache, ROL } = require("../db");
const { AppError } = require("../utils/AppError");

// Columnas que el catalogo publico puede filtrar. Lista explicita a proposito:
// si manana se agrega una columna interna (costo real, notas del hotel, quien la
// mantiene) NO sale sola en el endpoint publico. Un SELECT * aca es una bomba de
// tiempo: filtra la columna nueva sin que nadie se entere.
const PUBLIC_COLUMNS = [
  "id",
  "numero",
  "nombre",
  "descripcion",
  "camas_individuales",
  "camas_matrimoniales",
  "capacidad_max",
  "tipo",
  "precio_noche",
  "activa",
  "created_at",
];

/** Arma la lista de columnas publica, opcionalmente con alias de tabla. */
const publicColumns = (alias) => {
  const prefix = alias ? `${alias}.` : "";
  return PUBLIC_COLUMNS.map((col) => `${prefix}${col}`).join(", ");
};

/**
 * Busca armando un WHERE incremental.
 *
 * Se evita repetir el `query += ...; params.push(...)` en cada filtro. El
 * placeholder se numera solo a partir de cuantos hay, asi que agregar un filtro
 * nuevo no obliga a recalcular indices a mano (que es como se cuelan los
 * bugs de SQL injection por concatenar `$1` mal numerado).
 */
class Filtros {
  constructor(condicionesIniciales = "") {
    this.query = condicionesIniciales;
    this.params = [];
  }

  agregar(fragmento, valor) {
    this.query += ` ${fragmento} $${this.params.length + 1}`;
    this.params.push(valor);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Publico
// ---------------------------------------------------------------------------

/**
 * Listado publico con filtros opcionales.
 *
 * @param {object} filtros `{ tipo, capacidad_min, precio_max, disponible_desde, disponible_hasta }`
 *   - `tipo` acepta uno o varios (`?tipo=Doble&tipo=Triple`).
 *   - La disponibilidad exige LAS DOS fechas: con una sola no se puede saber si
 *     la habitacion queda libre, asi que es un 400 explicito y no un filtro
 *     silenciosamente ignorado.
 */
async function listarPublico({
  tipo,
  capacidad_min,
  precio_max,
  disponible_desde,
  disponible_hasta,
}) {
  const filtros = new Filtros(`WHERE activa = true`);

  if (tipo) {
    const tipos = Array.isArray(tipo) ? tipo : [tipo];
    let contador = filtros.params.length;
    const placeholders = tipos.map(() => `$${++contador}`);
    filtros.query += ` AND tipo IN (${placeholders.join(", ")})`;
    filtros.params.push(...tipos);
  }

  if (capacidad_min) {
    filtros.agregar("AND capacidad_max >=", parseInt(capacidad_min, 10));
  }

  if (precio_max) {
    filtros.agregar("AND precio_noche <=", parseFloat(precio_max));
  }

  if (disponible_desde && disponible_hasta) {
    // Los placeholders siguen la cantidad de params que ya se acumularon: si
    // venia uno, la funcion recibe $2 y $3.
    const base = filtros.params.length;
    filtros.query += ` AND id = ANY(SELECT habitacion_id FROM habitaciones_disponibles_en_rango($${base + 1}, $${base + 2}))`;
    filtros.params.push(disponible_desde, disponible_hasta);
  } else if (disponible_desde || disponible_hasta) {
    throw new AppError(
      "Deben proporcionarse ambas fechas (desde y hasta) para filtrar disponibilidad",
      400
    );
  }

  const result = await executeQuery(
    `SELECT ${publicColumns()} FROM Habitacion ${filtros.query} ORDER BY numero`,
    filtros.params,
    ROL.PUBLICO
  );

  return result.rows;
}

/** Detalle de una habitacion, publica. Solo si esta activa. */
async function obtenerPublico(id) {
  const result = await executeQuery(
    `SELECT ${publicColumns()} FROM Habitacion WHERE id = $1 AND activa = true`,
    [id],
    ROL.PUBLICO
  );

  if (result.rows.length === 0) throw new AppError("Habitacion no encontrada", 404);
  return result.rows[0];
}

/** Habitaciones libres en un rango de fechas. Es lo que usa "Buscar disponibilidad". */
async function listarDisponibles(desde, hasta) {
  if (!desde || !hasta) {
    throw new AppError("Parametros 'desde' y 'hasta' son requeridos (YYYY-MM-DD)", 400);
  }

  const result = await executeQuery(
    `SELECT ${publicColumns("h")} FROM Habitacion h
     WHERE h.activa = true
       AND h.id = ANY(SELECT habitacion_id FROM habitaciones_disponibles_en_rango($1, $2))
     ORDER BY h.numero`,
    [desde, hasta],
    ROL.PUBLICO
  );

  return result.rows;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function crear(datos) {
  const {
    numero,
    nombre,
    descripcion,
    camas_individuales,
    camas_matrimoniales,
    capacidad_max,
    tipo,
    precio_noche,
  } = datos;

  const result = await executeQuery(
    `INSERT INTO Habitacion (numero, nombre, descripcion, camas_individuales, camas_matrimoniales, capacidad_max, tipo, precio_noche)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      numero,
      nombre,
      descripcion,
      camas_individuales || 0,
      camas_matrimoniales || 0,
      capacidad_max,
      tipo,
      precio_noche,
    ],
    ROL.ADMIN
  );

  await cache.invalidateAll();
  return result.rows[0];
}

/** Actualizacion parcial: los campos que llegan en null no se tocan. */
async function actualizar(id, datos) {
  const {
    numero,
    nombre,
    descripcion,
    camas_individuales,
    camas_matrimoniales,
    capacidad_max,
    tipo,
    precio_noche,
    activa,
  } = datos;

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
    [
      numero,
      nombre,
      descripcion,
      camas_individuales,
      camas_matrimoniales,
      capacidad_max,
      tipo,
      precio_noche,
      activa,
      id,
    ],
    ROL.ADMIN
  );

  if (result.rows.length === 0) throw new AppError("Habitacion no encontrada", 404);

  await cache.invalidateAll();
  return result.rows[0];
}

/**
 * Elimina una habitacion.
 *
 * El chequeo de reservas va con `{ role: "admin" }` explicito a proposito. Sin
 * el, RLS filtra la consulta y el SELECT devuelve siempre 0 filas, o sea que el
 * hotel podria borrar una habitacion con reservas activas y perderlas.
 */
async function eliminar(id) {
  const conReservas = await executeQuery(
    "SELECT id FROM Reserva WHERE habitacion_id = $1 AND estado IN ('Pendiente', 'Confirmada') LIMIT 1",
    [id],
    ROL.ADMIN
  );

  if (conReservas.rows.length > 0) {
    throw new AppError("No se puede eliminar la habitacion porque tiene reservas activas", 409);
  }

  const result = await executeQuery(
    "DELETE FROM Habitacion WHERE id = $1 RETURNING *",
    [id],
    ROL.ADMIN
  );
  if (result.rows.length === 0) throw new AppError("Habitacion no encontrada", 404);

  await cache.invalidateAll();
  return result.rows[0];
}

module.exports = {
  listarPublico,
  obtenerPublico,
  listarDisponibles,
  crear,
  actualizar,
  eliminar,
  PUBLIC_COLUMNS,
  publicColumns,
};
