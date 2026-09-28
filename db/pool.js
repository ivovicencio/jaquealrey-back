//aca se configura el grupo de conexiones usando la libreria pg
//y la url que esta en .env, mantiene las conexiones abiertas y listar para ser usadas sin
//tener que conectar y desconectar cada segundo
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
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
