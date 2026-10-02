/**
 * Arranque y cierre del proceso.
 *
 * Separa las tres cosas que no son construir la app:
 *   - crear el servidor HTTP
 *   - enchufar Socket.IO
 *   - escuchar el puerto
 *   - cerrar todo en orden cuando llega SIGTERM/SIGINT
 *
 * El cierre ordenado importa en despliegue: sin el, cada redeploy corta las
 * consultas a medio hacer. Con el, el orquestador manda SIGTERM, el proceso deja
 * de aceptar conexiones, termina lo que tiene a medias y cierra la base.
 */

const http = require("http");

const app = require("./app");
const config = require("./config");
const { pool, cache } = require("./db");
const { initSocket } = require("./socket/socket");
const { iniciarJobExpiracion, detenerJobExpiracion } = require("./services/expiracion.service");

const server = http.createServer(app);
initSocket(server);

// El job que libera las reservas sin pagar. Prende acá y no en app.js porque es
// efecto de proceso (solo tiene sentido con el server Levantando), igual que el
// socket.
iniciarJobExpiracion();

server.listen(config.port, () => {
  console.log(`[Server] Hotel Jaque al Rey API corriendo en puerto ${config.port}`);
});

function gracefulShutdown(signal) {
  console.log(`\n[Server] Señal ${signal} recibida. Cerrando servidor...`);

  // Primero el job: si no, puede estar a mitad de una transaccion liberando
  // reservas cuando se le corta la conexion debajo.
  detenerJobExpiracion();

  server.close(() => {
    console.log("[Server] Servidor HTTP cerrado");
    cache.close().finally(() => {
      pool.end(() => {
        console.log("[Server] Pool PostgreSQL cerrado");
        process.exit(0);
      });
    });
  });

  // Si algo se cuelga y no cierra, no esperamos indefinidamente.
  setTimeout(() => {
    console.error("[Server] Shutdown forzado por timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

module.exports = app;
