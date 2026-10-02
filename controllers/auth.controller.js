/**
 * Auth — capa HTTP.
 *
 * Los controllers no tienen reglas de negocio ni SQL: extraen lo que viene del
 * request, se lo pasan al service y formatean la respuesta. Todo lo que es
 * decision del sistema vive en `services/auth.service.js`.
 */

const { success } = require("../utils/response");
const handle = require("../utils/handle");
const authService = require("../services/auth.service");

const authCtrl = {};

authCtrl.register = handle(async (req, res) => {
  const { user, token } = await authService.registrar(req.body);
  return success(res, "Registro exitoso", { user, token }, 201);
});

authCtrl.login = handle(async (req, res) => {
  const { user, token } = await authService.login(req.body, req);
  return success(res, "Inicio de sesion exitoso", { user, token });
});

authCtrl.logout = handle(async (req, res) => {
  await authService.logout(req.userId);
  return success(res, "Sesion cerrada");
});

authCtrl.changePassword = handle(async (req, res) => {
  const mensaje = await authService.cambiarPassword(req.body, {
    userId: req.userId,
    role: req.role,
  });
  return success(res, mensaje);
});

module.exports = authCtrl;
