const rateLimit = require("express-rate-limit");

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { status: "0", msg: "Demasiadas solicitudes, intentá de nuevo en 15 minutos", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: "0", msg: "Demasiados intentos de login, intentá de nuevo en 15 minutos", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { status: "0", msg: "Demasiados registros desde esta IP, intentá de nuevo en 1 hora", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

const reservaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { status: "0", msg: "Demasiadas reservas, intentá de nuevo en 15 minutos", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { status: "0", msg: "Demasiadas solicitudes administrativas", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

const userLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.userId ? `user_${req.userId}` : rateLimit.ipKeyGenerator(req),
  message: { status: "0", msg: "Demasiadas solicitudes, esperá un minuto", data: [] },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  globalLimiter,
  loginLimiter,
  registerLimiter,
  reservaLimiter,
  adminLimiter,
  userLimiter,
};
