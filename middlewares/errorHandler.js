/**
 * Manejo global de errores.
 *
 * Ultimo middleware de la cadena: convierte cualquier error que llega hasta aca
 * en la respuesta de la API, con el formato comun `{ status: "0", msg, data }`.
 *
 * Que sea el ultimo es lo que hace que los errores de los controllers no
 * terminen como 500 con stack trace: cualquier `throw` de un service que no se
 * atrapo antes llega aqui.
 */

const { traducir } = require("../utils/errores");

// `next` no se usa, pero Express identifica un handler de errores por tener los
// 4 parametros: si falta, el error se trata como middleware normal y nunca llega.
function errorHandler(err, req, res, next) {
  const { status, msg } = traducir(err);
  return res.status(status).json({ status: "0", msg, data: [] });
}

module.exports = errorHandler;
