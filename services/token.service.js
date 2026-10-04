/**
 * Gestión de tokens de dispositivos para notificaciones Push.
 *
 * Cuando un celular o PC abre la app, genera un token único de FCM.
 * Este token se guarda aquí para que el servidor sepa a quién notificar.
 */
const { executeQuery } = require("../db");
const { ROL } = require("../db");

async function registrarToken(userId, token, dispositivo) {
  // Insertamos o actualizamos el token para el usuario/dispositivo.
  // Si el dispositivo ya existe para ese usuario, actualizamos el token.
  await executeQuery(
    `INSERT INTO DeviceTokens (user_id, token, dispositivo, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, dispositivo)
     DO UPDATE SET token = EXCLUDED.token, updated_at = NOW()`,
    [userId, token, dispositivo],
    ROL.ADMIN
  );
}

async function obtenerTokensDeUsuario(userId) {
  const result = await executeQuery(
    "SELECT token FROM DeviceTokens WHERE user_id = $1",
    [userId],
    ROL.ADMIN
  );
  return result.rows.map(r => r.token);
}

module.exports = {
  registrarToken,
  obtenerTokensDeUsuario
};
