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

async function iniciarServidor() {
  if (config.isProduction) {
    const rol = await pool.query(
      `SELECT rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`
    );

    if (
      rol.rows.length !== 1 ||
      rol.rows[0].rolsuper ||
      rol.rows[0].rolbypassrls
    ) {
      throw new Error("DATABASE_URL debe usar un rol PostgreSQL sin SUPERUSER ni BYPASSRLS");
    }

    const tablas = await pool.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relname = ANY($1)`,
      [["hotel", "habitacion", "cliente", "reserva", "historialreserva", "pago", "configuracion"]]
    );
    const tablasInseguras = tablas.rows
      .filter((tabla) => !tabla.relrowsecurity || !tabla.relforcerowsecurity)
      .map((tabla) => tabla.relname);
    if (tablas.rows.length !== 7 || tablasInseguras.length > 0) {
      throw new Error(
        `Falta aplicar FORCE ROW LEVEL SECURITY en tablas criticas: ${tablasInseguras.join(", ") || "esquema incompleto"}`
      );
    }
  }

  server.listen(config.port, () => {
    console.log(`[Server] Hotel Jaque al Rey API corriendo en puerto ${config.port}`);
  });
}

iniciarServidor().catch((error) => {
  console.error(`[FATAL] No se inicia la API: ${error.message}`);
  detenerJobExpiracion();
  cache.close().finally(() => {
    pool.end(() => process.exit(1));
  });
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
