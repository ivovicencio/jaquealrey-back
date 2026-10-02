/**
 * Error de dominio: un error que la aplicacion espera y sabe explicar.
 *
 * Los services lanzan estos errores en vez de fabricar respuestas HTTP. Quien
 * traduce a status + JSON es `middlewares/errorHandler.js`, que ya mapea
 * cualquier error con `.status`.
 *
 * La diferencia con `throw new Error(...)` es la misma que hay entre un fallo
 * esperado y uno de verdad:
 *
 *   - esperado: "la habitacion no esta disponible" -> 409, el huesped lo entiende
 *   - de verdad: se corto la base                 -> 500, hay que mirarlo
 *
 * Con este tipo, un error de dominio nunca llega a logearse como error de
 * servidor ni se le muestra al usuario el detalle de un fallo interno.
 */
class AppError extends Error {
  /**
   * @param {string} mensaje  Texto que ve el usuario. Sin datos sensibles.
   * @param {number} status   Codigo HTTP (400, 401, 404, 409...).
   */
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.name = "AppError";
    this.status = status;
  }
}

module.exports = { AppError };
