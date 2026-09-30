require("dotenv").config();

const express = require("express");
const compression = require("compression"); //comprime respuestas http
const helmet = require("helmet"); //protege la aplicacion de vulnerabilidades conocidas
const cors = require("cors"); //permite solicitudes de otros dominios
const http = require("http"); //para crear el servidor http
const { pool, cache } = require("./db"); //pool de conexiones a la base de datos y cache
const { globalLimiter } = require("./middlewares/rateLimiter"); //para limitar la cantidad de solicitudes por IP
const errorHandler = require("./middlewares/errorHandler"); //manejo de errores
const { initSocket } = require("./socket/socket"); //inicializa el socket.io, socket para notificaciones en tiempo real
const { sanitize } = require("./middlewares/sanitize"); //sanitiza las entradas de los usuarios para prevenir ataques XSS

const app = express();

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production"; //verificamos si estamos en produccion

const REQUIRED_ENV = ["JWT_SECRET", "DATABASE_URL"]; //vemos si tenemos las variables de entorno necesarias para que la app funcione
//se inicializan en un array
for (const envVar of REQUIRED_ENV) { //recorre para ver si estan configuradas
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

//para proteger la app
app.use(
  helmet({
    contentSecurityPolicy: { //para proteger la app de ataques XSS y clickjacking
      directives: { 
        defaultSrc: ["'none'"], //solo carga contenido del mismo origen
        connectSrc: ["'self'"], //solo permite conexiones al mismo origen
        frameSrc: ["'none'"], //solo permite cargar contenido en iframes del mismo origen
        scriptSrc: ["'self'"], //solo deja cargar scripts del mismo origen
      },
    },
    referrerPolicy: { policy: "no-referrer" }, //no enviar el referer en las solicitudes, referer es la url de la pagina que hace la solicitud, esto es para proteger la privacidad del usuario
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false, //para que el navegador solo use https, maxage es el tiempo en segundos que el navegador recordara que solo debe usar https, includesubdomains sirve para que todos los subdominios tambien usen https, preload es para que el navegador agregue el dominio a la lista de precarga de HSTS
    noSniff: true, //para que el navegador no intente adivinar el tipo de contenido, esto es para proteger la privacidad del usuario
    frameguard: { action: "deny" }, //para que el navegador no permita que la app se cargue en un iframe, esto es para proteger la app de ataques clickjacking
  })
);

//aca se configura cors, para que solo se pueda acceder a la api desde los dominios permitidos, si no se configura cors, cualquier dominio podria acceder a la api y eso es un riesgo de seguridad
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
        const denied = new Error("No autorizado por CORS");
        denied.status = 403;
        callback(denied);
      }
    },
    credentials: true,
  })
);

app.disable("x-powered-by"); //se desactiva la cabecera x-powered-by para que no se sepa que la app esta hecha con express, esto es para proteger la app de ataques dirigidos a express

// Sin esto, detras de un proxy (Vercel, nginx) req.ip es la IP del proxy y no
// la del visitante. Consecuencia: todos los clientes comparten un mismo
// contador de rate limit, asi que 200 requests de cualquiera pueden dejar sin
// servicio a todo el hotel. "1" confía un solo salto, que es lo que corresponde
// a un proxy delante. No se pone "true" a la ligera: con "true" el cliente
// mismo elige su IP via X-Forwarded-For y se saltea los limites.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

app.use(express.json({ limit: "1mb" })); //aca se configura el limite de tamaño de las solicitudes json, para evitar ataques de denegacion de servicio, si no se configura esto, un atacante podria enviar solicitudes muy grandes y saturar el servidor
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
const adminRoutes = require("./routes/admin.route");
const mpRoutes = require("./routes/mp.route");

app.use("/api/auth", authRoutes);
app.use("/api/hotel", hotelRoutes);
app.use("/api/habitaciones", habitacionRoutes);
app.use("/api/reservas", reservaRoutes);
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
