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
