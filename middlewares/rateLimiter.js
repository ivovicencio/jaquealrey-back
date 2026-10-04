/**
 * Rate limiting.
 *
 * Los numeros vienen de `config.limites`, donde ya se leyeron y validaron desde
 * el entorno. Aca no se lee ninguna variable: si hace falta cambiar un limite,
 * se cambia en config/index.js y en el .env, no en dos lugares.
 */

const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const config = require("../config");

const MIN = 60 * 1000;

const globalLimiter = rateLimit({
  windowMs: 15 * MIN,
  max: config.limites.global,
  message: { status: "0", msg: "Demasiadas solicitudes, intentá de nuevo en 15 minutos", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

// El limite estricto va aca, no en las reservas. El login es el unico
// endpoint que hay que frenar fuerte, porque es el que se ataca solo, y
// encima tiene el bloqueo por IP de mas abajo. Un limite de 20 sobre login
// solo molestaria a un admin que se equivoca la contrasena.
const loginLimiter = rateLimit({
  windowMs: 15 * MIN,
  max: config.limites.login,
  message: {
    status: "0",
    msg: "Demasiados intentos de login, intentá de nuevo en 15 minutos",
    data: [],
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// El registro esta cerrado al admin (secrets + email), asi que es trafico
// humano y no deelatante: 5 por hora es prudente sin arrivedar.
const registerLimiter = rateLimit({
  windowMs: 60 * MIN,
  max: config.limites.registro,
  message: {
    status: "0",
    msg: "Demasiados registros desde esta IP, intentá de nuevo en 1 hora",
    data: [],
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const reservaLimiter = rateLimit({
  windowMs: 15 * MIN,
  // 60 y no 20, y esto importa en produccion. Los huespedes de un hotel
  // salen todos por la MISMA IP publica (la del wifi, por NAT): veinte
  // reservas en quince minutos no son veinte atacantes, son veinte huespedes
  // legitimos del mismo hotel. Con 20 el hotel perdia ventas por un limite
  // que en realidad no frena nada, porque el que abusa puede rotar de IP
  // trivialmente. El freno real de la ReservationBomb esta mas abajo, en el
  // limite por email.
  max: config.limites.reserva,
  message: {
    status: "0",
    msg: "Demasiadas reservas desde esta conexion, intentá de nuevo en 15 minutos",
    data: [],
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Frena la reserva-bomba sin tocar el limite por IP.
//
// El abuso real (revender, completar la agenda con reservas falsas) se
// detecta por el EMAIL, no por la IP: el que abusa tiene que inventar un
// email distinto por reserva, porque reutilizar el suyo lo deja con una sola
// reserva imposible de borrar. Un limite de 5 por hora y por email permite
// que un huesped real reserve una vez, que es lo que pasa, y revienta al que
// tries llenarlo.
//
// Va solo en el POST de crear. Cancelar y consultar usan codigo + email y son
// de un huesped que ya reserve, asi que no entran.
const reservaEmailLimiter = rateLimit({
  windowMs: 60 * MIN,
  max: config.limites.reservaPorEmail,
  keyGenerator: (req) => {
    // El email no siempre viene en el body: /consultar es un GET y lo manda
    // por query. Si el keyGenerator solo mirara req.body, en /consultar caeria
    // siempre al bucket "sin email" y el limite por email no existiria
    // justamente en la ruta que mas lo necesita.
    const crudo =
      (req.body && req.body.email) || (req.query && req.query.email) || "";
    const email = String(crudo).trim().toLowerCase();
    if (!email) return `reserva_sin_email_${ipKeyGenerator(req.ip || "")}`;
    return `reserva_email_${email}`;
  },
  message: {
    status: "0",
    msg: "Ya hay demasiadas consultas con ese email",
    data: [],
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 15 * MIN,
  max: config.limites.admin,
  message: { status: "0", msg: "Demasiadas solicitudes administrativas", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

const userLimiter = rateLimit({
  windowMs: 1 * MIN,
  max: config.limites.usuario,
  // req.ip y no x-forwarded-for: esa cabecera la manda el cliente y se cambia
  // en una línea, con lo cual cualquiera se saltea el límite a voluntad.
  // req.ip ya viene resuelta por Express usando trust proxy.
  // ipKeyGenerator además colapsa IPv6 a su /64: sin eso, un cliente IPv6
  // tiene un /64 entero de direcciones para rotar y esquivar el límite.
  keyGenerator: (req) => (req.userId ? `user_${req.userId}` : ipKeyGenerator(req.ip || "")),
  message: { status: "0", msg: "Demasiadas solicitudes, esperá un minuto", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

// ------------------------------------------------------------------
// Bloqueo temporal por intentos fallidos de login
// ------------------------------------------------------------------
// El loginLimiter de arriba frena el volumen, pero no frena el ataque lento:
// 9 intentos cada 16 minutos nunca lo dispara. Esto bloquea la IP un rato
// después de N fallos, y lo destraba solo con el tiempo.
//
// Es memoria del proceso, no Redis: se reinicia con el server. Para este caso
// es aceptable (perder el conteo solo reinicia el reloj, no lo saltea), pero
// en serverless cada instancia tiene la suya. Si alguna vez hace falta que el
// bloqueo sea global, el lugar es Redis y no este Map.
// ------------------------------------------------------------------
const MAX_FALLIDOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

const fallos = new Map();

// Una clave por IP "de verdad". ipKeyGenerator trunca IPv6 a /64, que es el
// equivalente real de una IP: sin eso, el atacante rota de dirección en un
// cliente IPv6 y el contador nunca llega a MAX_FALLIDOS.
const claveDe = (req) => ipKeyGenerator(req.ip || "unknown");

function barrerAtras(now) {
  for (const [ip, reg] of fallos) {
    if (now - reg.ultimo > BLOQUEO_MS) fallos.delete(ip);
  }
}

function comprobarBloqueo(req, res, next) {
  const ahora = Date.now();
  barrerAtras(ahora);

  const ip = claveDe(req);
  const reg = fallos.get(ip);

  if (reg && reg.bloqueadaHasta > ahora) {
    const minutos = Math.max(1, Math.ceil((reg.bloqueadaHasta - ahora) / 60000));
    res.setHeader("Retry-After", String(Math.ceil((reg.bloqueadaHasta - ahora) / 1000)));
    return res.status(429).json({
      status: "0",
      msg: `Demasiados intentos fallidos. Cuenta bloqueada por ${minutos} minuto(s).`,
      data: [],
    });
  }

  return next();
}

function registrarFallo(req) {
  const ahora = Date.now();
  const ip = claveDe(req);
  const reg = fallos.get(ip) || { cuenta: 0, bloqueadaHasta: 0, ultimo: ahora };

  reg.cuenta += 1;
  reg.ultimo = ahora;

  if (reg.cuenta >= MAX_FALLIDOS) {
    reg.bloqueadaHasta = ahora + BLOQUEO_MS;
    reg.cuenta = 0;
    console.warn(`[Security] Login bloqueado ${BLOQUEO_MS / 60000} min para ${ip}`);
  }

  fallos.set(ip, reg);
}

function limpiarFallo(req) {
  fallos.delete(claveDe(req));
}

// Va antes del controlador, en la ruta de login. El controlador llama a
// registrarFallo() cuando la contraseña no coincide y a limpiarFallo() cuando
// sí, así que solo cuentan los intentos realmente fallidos.
//
// OJO: esto es el middleware Directo, no una fabrica. Si devolviéramos
// (req,res,next) => ... y la ruta lo usara como loginLockout() seria igual de
// correcto, pero la ruta lo pasa suelto: si esta funcion devolviera otra
// funcion, Express la invocaria con (req,res,next), descartaria el retorno y
// next() no se llamaria nunca. El login quedaria colgado para siempre.
function loginLockout(req, res, next) {
  return comprobarBloqueo(req, res, next);
}

module.exports = {
  globalLimiter,
  loginLimiter,
  registerLimiter,
  reservaLimiter,
  reservaEmailLimiter,
  adminLimiter,
  userLimiter,
  loginLockout,
  registrarFallo,
  limpiarFallo,
};
