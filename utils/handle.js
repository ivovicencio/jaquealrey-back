/**
 * Envuelve un handler de controller.
 *
 * Por HTTP, Express 5 ya rutea solo el rechazo de una funcion async hacia el
 * errorHandler. Este wrapper parece redundante y no lo es: los tests de reglas de
 * negocio que "no llegan por HTTP" invocan los controllers con un `res` falso,
 * sin cadena de middlewares. Sin esto, un AppError de 400 se leseria como
 * exception y el test veria un 500.
 *
 * Aporta poco codigo y deja el comportamiento identico en los dos caminos: los
 * errores se traducen con el mismo criterio de utils/errores.js.
 */

const { traducir } = require("./errores");

function handle(fn) {
  return async function (req, res, next) {
    try {
      return await fn(req, res);
    } catch (err) {
      // Si la respuesta ya empezo a salir, no se intenta escribir otra: Express
      // solo avisa por consola, pero el cliente recibe basura concatenada.
      if (res.headersSent) return next(err);

      const { status, msg } = traducir(err);
      return res.status(status).json({ status: "0", msg, data: [] });
    }
  };
}

module.exports = handle;
