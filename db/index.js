/**
 * Acceso a PostgreSQL.
 *
 * Punto de entrada UNICO a la base y el unico que sabe de transacciones y del
 * mecanismo de Row Level Security. El SQL concreto vive en `services/`: lo que
 * se garantiza aca es que toda consulta pase por acá, con su rol y sus
 * placeholders, y que una operacion de varias consultas sea atomica.
 *
 * Que el SQL no este en los controllers es lo que hace que las capas se puedan
 * testear y cambiar por separado: cambiar una consulta es editar un service, no
 * reescribir un endpoint.
 *
 * ## Row Level Security
 *
 * Postgres tiene las politicas RLS activas sobre las tablas (ver db/migrations/).
 * Para que una consulta pase o no, hay que:setear el rol de la sesion. Por eso
 * `executeQuery` y `withTransaction` abren una transaccion y ejecutan
 * `set_config('app.role', ...)` ANTES de la consulta del usuario.
 *
 * Ojo con el detalle: no se puede usar `SET LOCAL app.role = $1` porque Postgres
 * no acepta placeholders en `SET`. De ahi el `set_config(..., true)`, que es
 * parametrizado y tiene el mismo efecto (el `true` = local a la transaccion).
 */

const pool = require("./pool");
const cache = require("./cache");

const VALID_ROLES = { admin: "admin", public: "public" };

/**
 * Contextos de RLS ya armados, para no repetir `{ role: "admin" }` en cada
 * consulta y para que el nivel de acceso pedido quede a la vista.
 */
const ROL = Object.freeze({
  ADMIN: Object.freeze({ role: "admin" }),
  PUBLICO: Object.freeze({ role: "public" }),
});

/** Aplica el rol y el usuario a la transaccion abierta. */
async function aplicarContexto(client, options = {}) {
  const role = VALID_ROLES[options.role] || "public";
  const userId = options.userId ? String(options.userId).replace(/[^0-9]/g, "") : "0";

  await client.query("SELECT set_config('app.role', $1, true)", [role]);
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
}

/**
 * Ejecuta UNA consulta y cierra la transaccion.
 *
 * Usar para lecturas y para escrituras simples. Si la operacion necesita que
 * dos consultas sean atomicas (o un lock de fila), usar `withTransaction`.
 *
 * @param {string} text     SQL parametrizado ($1, $2, ...). Nunca concatenar.
 * @param {Array}  params   Valores de los placeholders.
 * @param {object} options  `{ role: "admin" | "public", userId }`
 */
async function executeQuery(text, params, options = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await aplicarContexto(client, options);

    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ejecuta varias consultas dentro de UNA transaccion.
 *
 * @param {Function} fn      Recibe el client de `pg` y hace las consultas.
 * @param {object}   options `{ role, userId }` — se aplica una sola vez, al abrir.
 *
 * Lo que devuelve es lo que devuelva `fn`. Los errores se propagan y disparan el
 * ROLLBACK, asi que `fn` no necesita try/catch para garantizar atomicidad.
 */
async function withTransaction(fn, options = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await aplicarContexto(client, options);

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, executeQuery, withTransaction, cache, ROL };
