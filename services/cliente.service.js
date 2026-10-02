/**
 * Clientes (huespedes y personal).
 *
 * Dato importante del dominio: el huesped NO tiene cuenta. No hay login ni
 * recuperacion de contrasena para el. Este service existe igual porque la tabla
 * `Cliente` guarda nombre, telefono y email de cada huesped, y ademas la fila
 * del admin (que si usa login).
 *
 * Toda lectura por email pasa por la funcion SQL `buscar_cliente_por_email()`,
 * que es SECURITY DEFINER: existe justamente para poder buscar un cliente sin
 * estar autenticado (el huesped reserva sin cuenta y el login busca por email).
 */

const { executeQuery, ROL } = require("../db");

/**
 * Busca por email usando la funcion que bypassa RLS.
 *
 * Devuelve `null` si no existe. `contrasuraPassword` incluye el hash: solo lo
 * necesita el login.
 */
async function buscarPorEmail(email, { conPassword = false } = {}) {
  const columnas = conPassword
    ? "id, nombre, apellido, email, telefono, password, created_at"
    : "id, nombre, apellido, email, telefono, created_at";

  const result = await executeQuery(`SELECT ${columnas} FROM buscar_cliente_por_email($1)`, [
    email,
  ]);

  return result.rows[0] || null;
}

/**
 * Crea el cliente del admin (registro). El huesped no pasa por aca: lo crea
 * reserva.service cuando reserva por primera vez.
 */
async function crearAdmin({ nombre, apellido, telefono, email, passwordHasheado }) {
  const result = await executeQuery(
    `INSERT INTO Cliente (nombre, apellido, telefono, email, password)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nombre, apellido, email, telefono, created_at`,
    [nombre, apellido || "", telefono, email, passwordHasheado],
    ROL.ADMIN
  );

  return result.rows[0];
}

/**
 * Guarda la credencial de un huesped recien creado.
 *
 * Se escribe "PENDIENTE" en el INSERT y el hash real se pone despues, fuera del
 * camino critico. Explicado en reserva.service: bcrypt con 12 rondas tarda
 * ~235ms y frena el event loop.
 */
async function guardarPasswordHasheado(clienteId, hash) {
  await executeQuery(
    "UPDATE Cliente SET password = $1 WHERE id = $2",
    [hash, clienteId],
    ROL.ADMIN
  );
}

/**
 * Mueve la marca de revocacion. Todo token emitido antes de este instante queda
 * invalido. Es lo que hace que el logout en el servidor sea real y no solo borrar
 * el token del navegador.
 *
 * @param {number} clienteId
 * @param {object} opciones `{ role, userId, adelanteSegundos }`
 */
async function revocarTokens(
  clienteId,
  { role = "admin", userId = clienteId, adelanteSegundos = 0 } = {}
) {
  const sql = adelanteSegundos
    ? "UPDATE Cliente SET tokens_validos_desde = NOW() + ($2 || ' seconds')::interval WHERE id = $1"
    : "UPDATE Cliente SET tokens_validos_desde = NOW() WHERE id = $1";

  const params = adelanteSegundos ? [clienteId, adelanteSegundos] : [clienteId];
  await executeQuery(sql, params, { role, userId });
}

/** Lectura puntual del hash, para el login y el cambio de contrasena. */
async function obtenerPassword(id, { role, userId }) {
  const result = await executeQuery("SELECT id, password FROM Cliente WHERE id = $1", [id], {
    role,
    userId,
  });
  return result.rows[0] || null;
}

/** Reemplaza el hash (cambio de contrasena). */
async function actualizarPassword(id, hash, { role, userId }) {
  await executeQuery("UPDATE Cliente SET password = $1 WHERE id = $2", [hash, id], {
    role,
    userId,
  });
}

module.exports = {
  buscarPorEmail,
  crearAdmin,
  guardarPasswordHasheado,
  revocarTokens,
  obtenerPassword,
  actualizarPassword,
};
