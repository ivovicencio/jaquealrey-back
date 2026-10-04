/**
 * Habitaciones: catalogo publico y administracion.
 *
 * El SQL vive aca. El controller solo traduce HTTP.
 */

const { executeQuery, withTransaction, cache, ROL } = require("../db");
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
    // habitaciones_disponibles_en_rango ya es SECURITY DEFINER (db/init.sql),
    // asi que su SELECT sobre Reserva ve las reservas que realmente hay y este
    // filtro sirve de verdad. Por eso NO hay que pasarle ROL.ADMIN: hacerlo
    // seria leaky por el otro lado, abriria el SELECT de reservas de todo el
    // mundo solo para poder leer un disponible. Si alguna vez esta llamada
    // devuelve una habitacion ocupada, el bug es que la funcion perdio el
    // SECURITY DEFINER, no que falte un ROL.ADMIN aca.
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

  // Esta consulta NO se cachea, a proposito, aunque sea la que mas se repite.
  //
  // La disponibilidad cambia con cada reserva que entra, cada cancelacion y cada
  // cambio de fecha, o sea que un TTL corto obliga a invalidar en tres sitios
  // distintos y un solo forget produce el peor fallo posible en un sistema de
  // reservas: mostrar una habitacion ocupada. El huésped la elige, el admin la
  // confirma y la constraint `reserva_sin_solapamiento` lo rechaza al final,
  // con el huésped esperando.
  //
  // Ademas el filtro no es una lectura de una tabla: va por
  // `habitaciones_disponibles_en_rango`, que ya esta indexada por rango. Cachear
  // solo moveria el costo de lugar.
  const result = await executeQuery(
    `SELECT ${publicColumns("h")} FROM Habitacion h
     WHERE h.activa = true
       -- Misma nota que en listarPublico: la función ya es SECURITY DEFINER,
       -- asi que este ROL.PUBLICO es correcto y no hay que pasarlo ROL.ADMIN.
       -- El endpoint público no puede filtrar por ROL.ADMIN porque cualquiera
       -- lo puede pedir.
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

  // `estado_operativo` NO se cambia por acá: tiene su propio endpoint, que
  // valida que no haya un huésped adentro y deja la entrada en la bitácora. Si se
  // aceptara acá, se podría poner 'libre' con alguien dentro saltándose esa
  // comprobación.
  const antes = await executeQuery(
    "SELECT numero, precio_noche, activa FROM Habitacion WHERE id = $1",
    [id],
    ROL.ADMIN
  );

  if (antes.rows.length === 0) throw new AppError("Habitacion no encontrada", 404);

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

  // Bitácora (PASOS.md 39). Solo los cambios que de verdad importan: el precio y
  // si la habitación dejó de estar en el mercado. Los textos y las camas no
  // generan ruido.
  const previa = antes.rows[0];
  const cambios = [];
  if (precio_noche !== undefined && precio_noche !== null && Number(precio_noche) !== Number(previa.precio_noche)) {
    cambios.push(`precio ${previa.precio_noche} → ${precio_noche}`);
  }
  if (activa !== undefined && activa !== null && Boolean(activa) !== Boolean(previa.activa)) {
    cambios.push(activa ? "reactivada" : "desactivada");
  }

  if (cambios.length > 0) {
    await executeQuery(
      `INSERT INTO HistorialHabitacion (habitacion_id, accion, detalle, realizada_por)
       VALUES ($1, 'Actualizada', $2, 'admin')`,
      [id, `Habitación ${previa.numero}: ${cambios.join(", ")}`],
      ROL.ADMIN
    );
  }

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
    "SELECT id FROM Reserva WHERE habitacion_id = $1 AND reserva_ocupa_habitacion(estado) LIMIT 1",
    [id],
    ROL.ADMIN
  );

  if (conReservas.rows.length > 0) {
    throw new AppError("No se puede eliminar la habitacion porque tiene reservas activas", 409);
  }

  // Un bloqueo vigente apunta a la habitación por FK. Sin esto, borrar una
  // habitación a la que le dejaron un bloqueo de "fuera de servicio" reventaría
  // con un 500 de violacion de foreign key en vez de un mensaje entendible.
  // No hay columna `activo`: un bloqueo está vigente si su rango agarra hoy.
  const bloqueos = await executeQuery(
    `SELECT COUNT(*)::int AS total
       FROM HabitacionBloqueo
      WHERE habitacion_id = $1 AND desde <= CURRENT_DATE AND hasta >= CURRENT_DATE`,
    [id],
    ROL.ADMIN
  );

  if (bloqueos.rows[0].total > 0) {
    throw new AppError(
      "No se puede eliminar la habitacion porque tiene bloqueos activos. Levantalos primero.",
      409
    );
  }

  // La bitácora sobrevive a la habitación (ON DELETE SET NULL), así que se
  // escribe en el mismo transaction. Si no, el registro se pierde justo cuando
  // más importa: el motivo por el que dejó de existir.
  const eliminada = await withTransaction(async (client) => {
    const del = await client.query(
      "DELETE FROM Habitacion WHERE id = $1 RETURNING *",
      [id],
      ROL.ADMIN
    );
    if (del.rows.length === 0) throw new AppError("Habitacion no encontrada", 404);

    const h = del.rows[0];

    await client.query(
      `INSERT INTO HistorialHabitacion (habitacion_id, accion, detalle, realizada_por)
       VALUES (NULL, 'Eliminada', $1, 'admin')`,
      [`Habitación ${h.numero} (${h.nombre}) eliminada del inventario`],
      ROL.ADMIN
    );

    return h;
  }, ROL.ADMIN);

  await cache.invalidateAll();
  return eliminada;
}

// ---------------------------------------------------------------------------
// Estado operativo (recepción)
// ---------------------------------------------------------------------------
//
// `estado_operativo` es distinto de `activa`:
//   - `activa = false`  → la habitación no existe más para el hotel.
//   - `estado_operativo` → existe, pero hoy no se puede vender.
//
// Y hay un tercer estado que NO es de la habitación: quién la está ocupando.
// Eso lo maneja el check-in y el check-out desde reserva.service.js, porque
// depende de la reserva, no de la habitación. Por eso este service NUNCA pone
// 'ocupada': si lo hiciera, el estado de la habitación y el de sus reservas
// empezarían a contradecirse sin que nadie lo note.

const ESTADOS_OPERATIVOS = ["libre", "ocupada", "limpieza", "mantenimiento"];

/**
 * Lista las habitaciones con su estado operativo. Es lo que muestra la pantalla
 * de recepción para saber de golpe cuál está limpia y cuál no.
 *
 * `activa = false` no se esconde acá: es una vista de admin, y el hotel tiene
 * que ver las que desactivó para no perderlas de vista.
 */
async function listarEstadoOperativo() {
  const result = await executeQuery(
    `SELECT h.id, h.numero, h.nombre, h.tipo, h.activa, h.estado_operativo,
            h.precio_noche::float,
            (SELECT COUNT(*)::int FROM Reserva r
              WHERE r.habitacion_id = h.id AND r.estado = 'En_Casa') AS occupied_reservas,
            (SELECT r.codigo FROM Reserva r
              WHERE r.habitacion_id = h.id AND r.estado = 'En_Casa'
              ORDER BY r.check_in_at DESC NULLS LAST LIMIT 1) AS reserva_en_casa,
            (SELECT c.nombre || ' ' || c.apellido FROM Reserva r
               JOIN Cliente c ON c.id = r.cliente_id
              WHERE r.habitacion_id = h.id AND r.estado = 'En_Casa'
              ORDER BY r.check_in_at DESC NULLS LAST LIMIT 1) AS huésped_en_casa
     FROM Habitacion h
     ORDER BY h.numero`,
    [],
    ROL.ADMIN
  );

  return result.rows;
}

/**
 * Cambia el estado operativo a mano.
 *
 * Es lo que usa el botón de "Limpieza terminada" (de 'limpieza' a 'libre') y el
 * de "Mantenimiento" de una habitación que se rompió.
 *
 * 'ocupada' NO se acepta desde acá. Ponerla a mano abre la puerta a que la
 * habitación quede 'ocupada' sin ninguna reserva En_Casa que la respalde, y
 * entonces 'ocupada' no dice nada. El único que la pone es el check-in.
 */
async function actualizarEstadoOperativo(habitacion_id, { estado_operativo }, ip) {
  if (!ESTADOS_OPERATIVOS.includes(estado_operativo)) {
    throw new AppError(
      `Estado operativo invalido. Valores: ${ESTADOS_OPERATIVOS.join(", ")}`,
      400
    );
  }

  if (estado_operativo === "ocupada") {
    throw new AppError(
      "El estado 'ocupada' lo pone el check-in, no a mano. Usá el check-in de una reserva.",
      400
    );
  }

  return withTransaction(async (client) => {
    const sel = await client.query(
      "SELECT id, numero, nombre, estado_operativo FROM Habitacion WHERE id = $1 FOR UPDATE",
      [habitacion_id]
    );

    if (sel.rows.length === 0) {
      throw new AppError("Habitacion no encontrada", 404);
    }

    const previa = sel.rows[0];

    // Idempotente: no ensucia la bitácora con un no-op.
    if (previa.estado_operativo === estado_operativo) {
      return previa;
    }

    // 'libre' con un huésped adentro es el peor estado posible: la habitación
    // vuelve al mercado con alguien dentro. Se chequea antes de escribir.
    if (estado_operativo === "libre") {
      const ocupada = await client.query(
        "SELECT id FROM Reserva WHERE habitacion_id = $1 AND estado = 'En_Casa' LIMIT 1",
        [habitacion_id]
      );

      if (ocupada.rows.length > 0) {
        throw new AppError(
          `La habitación ${previa.numero} tiene un huésped adentro. Hacé el check-out primero.`,
          409
        );
      }
    }

    const upd = await client.query(
      "UPDATE Habitacion SET estado_operativo = $1 WHERE id = $2 RETURNING *",
      [estado_operativo, habitacion_id]
    );

    await client.query(
      `INSERT INTO HistorialHabitacion (habitacion_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'EstadoOperativo', $2, 'admin', $3)`,
      [
        habitacion_id,
        `Habitación ${previa.numero}: ${previa.estado_operativo} → ${estado_operativo}`,
        ip,
      ]
    );

    return upd.rows[0];
  }, ROL.ADMIN);
}

/** Azúcar sintáctico para el caso más común: la limpieza terminó. */
async function reactivar(habitacion_id, ip) {
  return actualizarEstadoOperativo(habitacion_id, { estado_operativo: "libre" }, ip);
}

// ---------------------------------------------------------------------------
// Bloqueos
// ---------------------------------------------------------------------------
//
// Un bloqueo aparta la habitación de la venta durante un rango de fechas, por un
// motivo concreto: reparación, baja del agua, humedad en la pared, pintar.
//
// Es distinto de `estado_operativo`. El estado dice "hoy no se puede ocupar";
// el bloqueo dice "estas fechas no se puede VENDER". Un bloqueo futuro no tiene
// por qué tocar el estado operativo todavía: la habitación puede estar vendible
// hoy y tener todo el mes que viene bloqueado.

async function listarBloqueos({ habitacion_id, solo_vigentes } = {}) {
  const result = await executeQuery(
    `SELECT b.id, b.habitacion_id, b.desde, b.hasta, b.motivo, b.creado_por, b.created_at,
            h.numero AS habitacion_numero, h.nombre AS habitacion_nombre,
            (b.desde <= CURRENT_DATE AND b.hasta >= CURRENT_DATE) AS vigente
       FROM HabitacionBloqueo b
       JOIN Habitacion h ON h.id = b.habitacion_id
      WHERE ($1::int IS NULL OR b.habitacion_id = $1::int)
        AND (NOT $2::boolean OR (b.desde <= CURRENT_DATE AND b.hasta >= CURRENT_DATE))
      ORDER BY b.desde DESC, b.id DESC`,
    [habitacion_id || null, Boolean(solo_vigentes)],
    ROL.ADMIN
  );

  return result.rows;
}

/**
 * Crea un bloqueo.
 *
 * Las dos validaciones que importan:
 *   1. Rango válido (`hasta > desde` lo garantiza la constraint, pero el mensaje
 *      del validator es mucho más útil que un 23514 crudo).
 *   2. No chocar con reservas que ya ocupen esa habitación en ese rango. Este es
 *      el motivo real del bloqueo: si hay un huésped con check-in el Thursday,
 *      bloquear el Thursday no lo corre de la habitación, lo deja trapped.
 *      Por eso es un 409 y no un aviso: la decisión es del hotel.
 */
async function crearBloqueo({ habitacion_id, desde, hasta, motivo }, ip) {
  if (new Date(hasta) <= new Date(desde)) {
    throw new AppError("La fecha 'hasta' tiene que ser posterior a 'desde'", 400);
  }

  return withTransaction(async (client) => {
    const hab = await client.query(
      "SELECT id, numero FROM Habitacion WHERE id = $1 FOR UPDATE",
      [habitacion_id],
      ROL.ADMIN
    );

    if (hab.rows.length === 0) {
      throw new AppError("Habitacion no encontrada", 404);
    }

    const choques = await client.query(
      `SELECT r.codigo, r.fecha_entrada, r.fecha_salida, c.nombre, c.apellido
         FROM Reserva r
         JOIN Cliente c ON c.id = r.cliente_id
        WHERE r.habitacion_id = $1
          AND reserva_ocupa_habitacion(r.estado)
          AND daterange(r.fecha_entrada, r.fecha_salida, '[)')
              && daterange($2::date, $3::date, '[)')
        ORDER BY r.fecha_entrada`,
      [habitacion_id, desde, hasta],
      ROL.ADMIN
    );

    if (choques.rows.length > 0) {
      const detalle = choques.rows
        .map((r) => `${r.codigo} (${r.nombre} ${r.apellido}, ${r.fecha_entrada} → ${r.fecha_salida})`)
        .join(", ");
      throw new AppError(
        `No se puede bloquear: hay reservas que chocan con el rango. ${detalle}`,
        409
      );
    }

    const ins = await client.query(
      `INSERT INTO HabitacionBloqueo (habitacion_id, desde, hasta, motivo, creado_por)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING *`,
      [habitacion_id, desde, hasta, motivo],
      ROL.ADMIN
    );

    await client.query(
      `INSERT INTO HistorialHabitacion (habitacion_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'BloqueoCreado', $2, 'admin', $3)`,
      [
        habitacion_id,
        `Habitación ${hab.rows[0].numero} bloqueada del ${desde} al ${hasta}: ${motivo}`,
        ip,
      ],
      ROL.ADMIN
    );

    return ins.rows[0];
  }, ROL.ADMIN);
}

/**
 * Levanta un bloqueo.
 *
 * Se borra en vez de marcarse como inactivo: la tabla no tiene columna `activo` a
 * propósito. Un bloqueo es un hecho ("estos días no se venden"), no un estado que
 * se pueda ir silenciosamente apagando, y así la bitácora de la habitación
 * conserva el rastro de qué se bloqueó y cuándo.
 */
async function levantarBloqueo(bloqueo_id, ip) {
  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT b.*, h.numero
         FROM HabitacionBloqueo b
         JOIN Habitacion h ON h.id = b.habitacion_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [bloqueo_id],
      ROL.ADMIN
    );

    if (sel.rows.length === 0) {
      throw new AppError("Bloqueo no encontrado", 404);
    }

    const b = sel.rows[0];

    const del = await client.query(
      "DELETE FROM HabitacionBloqueo WHERE id = $1 RETURNING *",
      [bloqueo_id],
      ROL.ADMIN
    );

    await client.query(
      `INSERT INTO HistorialHabitacion (habitacion_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'BloqueoLevantado', $2, 'admin', $3)`,
      [b.habitacion_id, `Bloqueo del ${b.desde} al ${b.hasta} levantado (${b.motivo})`, ip],
      ROL.ADMIN
    );

    return del.rows[0];
  }, ROL.ADMIN);
}

module.exports = {
  listarPublico,
  obtenerPublico,
  listarDisponibles,
  crear,
  actualizar,
  eliminar,
  actualizarEstadoOperativo,
  reactivar,
  listarEstadoOperativo,
  listarBloqueos,
  crearBloqueo,
  levantarBloqueo,
  PUBLIC_COLUMNS,
  publicColumns,
};
