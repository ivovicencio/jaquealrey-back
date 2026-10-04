/**
 * La aplicacion Express.
 *
 * Aca se arma la cadena de middlewares y se montan las rutas, en el orden
 * correcto. Que este archivo NO escuche el puerto es intencional: `app.js` es la
 * app (testeable, sin efectos de red) y `server.js` es quien la levanta.
 *
 * EL ORDEN DE ESTE ARCHIVO IMPORTA
 *
 *   1. compression            antes de todo: hay que comprimir antes de generar
 *   2. helmet                 cabeceras de seguridad
 *   3. cors                   origen permitido
 *   4. trust proxy            para reconstruir req.ip (va antes del rate limit)
 *   5. parsers                cuerpo de la request
 *   6. sanitize               limpia la entrada
 *   7. /health                SIN rate limit (ver comentario abajo)
 *   8. rate limit global      a partir de aca
 *   9. rutas
 *  10. 404 + error handler
 */

const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");

const config = require("./config");
const { pool } = require("./db");
const { globalLimiter } = require("./middlewares/rateLimiter");
const { sanitize } = require("./middlewares/sanitize");
const errorHandler = require("./middlewares/errorHandler");

const app = express();

// No se anuncia la tecnologia del servidor.
app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// 1. Compression
// ---------------------------------------------------------------------------

app.use(compression());

// ---------------------------------------------------------------------------
// 2. Helmet
// ---------------------------------------------------------------------------

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
    hsts: config.isProduction
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    noSniff: true,
    frameguard: { action: "deny" },
  })
);

// ---------------------------------------------------------------------------
// 3. CORS
// ---------------------------------------------------------------------------

// Si no se configura CORS, cualquier dominio podria llamar a la API. La lista
// blanca sale de CORS_ORIGIN (validada en config/index.js).
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.http.allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        const denied = new Error("No autorizado por CORS");
        denied.status = 403;
        callback(denied);
      }
    },
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-access-token"],
    maxAge: 600,
  })
);

// ---------------------------------------------------------------------------
// 4. Trust proxy
// ---------------------------------------------------------------------------

// Sin esto, detras de un proxy (Railway, nginx, Vercel) req.ip es la IP del proxy
// y no la del visitante. Consecuencia: todos los clientes comparten un mismo
// contador de rate limit, asi que 200 requests de cualquiera pueden dejar sin
// servicio a todo el hotel.
//
// "1" confía un solo salto, que es lo que corresponde a un proxy delante. No se
// pone "true" a la ligera: con "true" el cliente mismo elige su IP via
// X-Forwarded-For y se saltea los limites.
app.set("trust proxy", config.http.trustProxyHops);

// ---------------------------------------------------------------------------
// 5. Parsers
// ---------------------------------------------------------------------------

// Limite de 1mb: sin esto, un atacante podria mandar cuerpos enormes y saturar
// el servidor solo con pedir memoria.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ---------------------------------------------------------------------------
// 6. Sanitize
// ---------------------------------------------------------------------------

app.use(sanitize);

// ---------------------------------------------------------------------------
// 7. Healthcheck — ANTES del rate limit
// ---------------------------------------------------------------------------

// Healthcheck para Railway/Docker/Render. Sin esto no hay forma de que un
// orquestador sepa si el proceso esta vivo: si Postgres no acepta conexiones
// tiene que responder 503, para que el healthcheck falle y no le mande trafico a
// un servicio que solo va a devolver 500.
//
// Va ANTES del rate limit global a proposito. El global son 300 requests cada 15
// minutos, y un orquestador que consulta cada 10 s los gasta solo: en 8 minutos
// el healthcheck empieza a recibir 429 y da por caido un servicio sano. Un
// endpoint de salud no se limita.
//
// La consulta es la minima que demuestra lo que importa: que hay una conexion
// real a la base. Un 200 con la base caida seria peor que no tener nada.
const healthHandler = async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({
      status: "1",
      msg: "ok",
      data: { db: "up", uptime: Math.round(process.uptime()) },
    });
  } catch (err) {
    console.error("[Health] Base no disponible:", err.message);
    return res.status(503).json({ status: "0", msg: "Base de datos no disponible", data: [] });
  }
};

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// ---------------------------------------------------------------------------
// 8. Rate limit global + ruta raiz
// ---------------------------------------------------------------------------

app.use("/api", globalLimiter);

app.get("/", (_req, res) => {
  res.json({ status: "1", msg: "Hotel Jaque al Rey API", data: [] });
});

// ---------------------------------------------------------------------------
// 9. Rutas
// ---------------------------------------------------------------------------

app.use("/api/auth", require("./routes/auth.route"));
app.use("/api/hotel", require("./routes/hotel.route"));
app.use("/api/habitaciones", require("./routes/habitacion.route"));
app.use("/api/reservas", require("./routes/reserva.route"));
app.use("/api/admin", require("./routes/admin.route"));
app.use("/api/pagos", require("./routes/pago.route"));

// ---------------------------------------------------------------------------
// 10. 404 y errores
// ---------------------------------------------------------------------------

// Sin esto, una ruta inexistente cae al errorHandler con un error sin status y
// termina en un 500: la API reporta como caido algo que en realidad no existe.
app.use((req, res) => {
  res.status(404).json({
    status: "0",
    msg: `Ruta no encontrada: ${req.method} ${req.path}`,
    data: [],
  });
});

app.use(errorHandler);

module.exports = app;
