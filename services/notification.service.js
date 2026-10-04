/**
 * Servicio de Notificaciones
 * Stub provisional para evitar crashes durante el arranque.
 */

module.exports = {
  notifyAdmins: async (title, message, data) => {
    console.log(`[NOTIFICATION] ${title}: ${message}`, data);
    return { success: true };
  }
};
