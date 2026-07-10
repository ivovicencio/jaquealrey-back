require("dotenv").config();

const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");
const http = require("http");
const { pool, cache } = require("./db");
const { globalLimiter } = require("./middlewares/rateLimiter");
const errorHandler = require("./middlewares/errorHandler");
const { initSocket } = require("./socket/socket");
const { sanitize } = require("./middlewares/sanitize");

const app = express();

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

const REQUIRED_ENV = ["JWT_SECRET", "DATABASE_URL"];
for (const envVar of REQUIRED_ENV) {
  if (!process.env[envVar]) {
    console.error(`[FATAL] ${envVar} no está configurado`);
    process.exit(1);
  }
}

if (isProduction && !process.env.CORS_ORIGIN) {
  console.error("[FATAL] CORS_ORIGIN es obligatorio en producción");
  process.exit(1);
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.error("[FATAL] JWT_SECRET debe tener al menos 32 caracteres");
  process.exit(1);
}

app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        scriptSrc: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    noSniff: true,
    frameguard: { action: "deny" },
  })
);

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:4200")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (isProduction && allowedOrigins.includes("*")) {
  console.error("[FATAL] CORS_ORIGIN no puede ser wildcard en producción");
  process.exit(1);
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("No autorizado por CORS"));
      }
    },
    credentials: true,
  })
);

app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(sanitize);

app.use("/api", globalLimiter);

app.get("/", (_req, res) => {
  res.json({ status: "1", msg: "Hotel Jaque al Rey API", data: [] });
});

const authRoutes = require("./routes/auth.route");
const hotelRoutes = require("./routes/hotel.route");
const habitacionRoutes = require("./routes/habitacion.route");
const reservaRoutes = require("./routes/reserva.route");
const clienteRoutes = require("./routes/cliente.route");
const adminRoutes = require("./routes/admin.route");
const mpRoutes = require("./routes/mp.route");

app.use("/api/auth", authRoutes);
app.use("/api/hotel", hotelRoutes);
app.use("/api/habitaciones", habitacionRoutes);
app.use("/api/reservas", reservaRoutes);
app.use("/api/clientes", clienteRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/pagos", mpRoutes);

app.use(errorHandler);

const server = http.createServer(app);
initSocket(server);

server.listen(PORT, () => {
  console.log(`[Server] Hotel Jaque al Rey API corriendo en puerto ${PORT}`);
});

function gracefulShutdown(signal) {
  console.log(`\n[Server] Señal ${signal} recibida. Cerrando servidor...`);
  server.close(() => {
    console.log("[Server] Servidor HTTP cerrado");
    cache.close().finally(() => {
      pool.end(() => {
        console.log("[Server] Pool PostgreSQL cerrado");
        process.exit(0);
      });
    });
  });

  setTimeout(() => {
    console.error("[Server] Shutdown forzado por timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

module.exports = app;
