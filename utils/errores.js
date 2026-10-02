/**
 * Traduccion de errores a respuesta HTTP.
 *
 * Vive aparte de middlewares/errorHandler.js porque dos lugares necesitan el
 * mismo criterio y no pueden estar desalineados:
 *
 *   - errorHandler, para lo que llega por HTTP
 *   - utils/handle.js, para cuando un controller se invoca directo (los tests de
 *     reglas de negocio llaman a los controllers con un `res` falso, sin pasar
 *     por Express)
 *
 * Si la traduccion estuviera duplicada, un dia se corrige el 500 del handler y el
 * controller directo sigue Contestando distinto.
 */

const config = require("../config");

// Se traduce por CODIGO de Postgres, no por el texto del mensaje: el texto
// cambia entre versiones y matchearlo es fragil.
const PG_ERROR_CODES = {
  23505: { status: 409, msg: "El registro ya existe (duplicado)" },
  23503: { status: 400, msg: "Violacion de clave foranea" },
  "22P02": { status: 400, msg: "Tipo de dato invalido" },
};

/**
 * Devuelve `{ status, msg }` para responder.
 *
 * Tres clases, en este orden:
 *   1. Error de Postgres -> codigo SQL.
 *   2. AppError -> son los errores que la aplicacion espera (un huesped que
 *      cancela fuera de plazo, una habitacion ocupada). Traen su status y su
 *      mensaje, y no se loguean.
 *   3. Cualquier otra cosa es un fallo real -> 500, y en produccion el detalle
 *      queda en el log, nunca en la respuesta.
 */
function traducir(err) {
  const pg = err && err.code && PG_ERROR_CODES[err.code];
  if (pg) {
    return { status: pg.status, msg: pg.msg };
  }

  if (err && err.status) {
    return { status: err.status, msg: err.message || "Error" };
  }

  console.error("[Error]", err);

  return {
    status: 500,
    msg: config.isProduction ? "Error interno del servidor" : err.message,
  };
}

module.exports = { traducir, PG_ERROR_CODES };
