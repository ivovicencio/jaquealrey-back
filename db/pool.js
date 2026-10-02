/**
 * Pool de conexiones a PostgreSQL.
 *
 * Un grupo de conexiones abiertas que se reusan entre requests. Sin esto cada
 * request abriria y cerraria una conexion TCP, que es de lo mas caro que hay
 * entre la app y la base.
 *
 * `jaquealrey_app` es el rol sin privilegios que usa la app en runtime. Es
 * justamente lo que hace que RLS valga de verdad: si la app se conectara con el
 * superusuario, las politicas de Row Level Security no se aplicarian y la
 * seguridad seria decorativa.
 */

const { Pool } = require("pg");
const config = require("../config");

const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("connect", () => {
  console.log("[DB] Conectado a PostgreSQL");
});

pool.on("error", (err) => {
  console.error("[DB] Error inesperado en el pool:", err.message);
});

module.exports = pool;
