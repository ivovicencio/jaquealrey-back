/**
 * Configuracion de la aplicacion.
 *
 * Toda variable de entorno se lee y valida ACA, una sola vez, al cargar el
 * modulo. El resto del codigo importa `config` y nunca toca `process.env`.
 *
 * Por que importa:
 *
 *  - Una variable leida en 8 archivos es 8 lugares donde puede faltar el default.
 *  - Un `parseInt(process.env.X)` repetido devuelve NaN en silencio si la variable
 *    no existe, y el NaN viaja hasta el final del request.
 *  - La validacion tiene que ser explicita y en un solo lugar. Si cada modulo
 *    chequea lo suyo, nadie sabe que se chequea todo.
 *
 * Regla de seguridad de este archivo: si algo falta o es peligroso, la app NO
 * arranca. Un hotel que no puede cobrar es peor que un hotel caido, y un hotel
 * caido se nota enseguida.
 */

require("dotenv").config();

const SECRETOS_EJEMPLO = [
  "debes_cambiar_esto_en_produccion",
  "dev_secret_no_usar_en_produccion_cambiar",
  "cambiar_en_produccion",
  "changeme",
  "secret",
  "jwt_secret",
  "supersecret",
  "pon_aqui_tu_secreto",
  "tu_admin_secret_aqui",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fatal(mensaje, detalle) {
  console.error(`[FATAL] ${mensaje}`);
  if (detalle) console.error(`        ${detalle}`);
  process.exit(1);
}

/** Devuelve la variable o corta el arranque. */
function obligatoria(nombre) {
  const valor = process.env[nombre];
  if (!valor || !valor.trim()) {
    fatal(`${nombre} no esta configurado`);
  }
  return valor.trim();
}

/** Devuelve la variable, o el default si no esta. */
function opcional(nombre, defaultValue) {
  const valor = process.env[nombre];
  return valor === undefined || valor === "" ? defaultValue : valor;
}

/** Igual que opcional, pero convierte a entero. Un NaN es un default, nunca un error silencioso. */
function entero(nombre, defaultValue) {
  const bruto = process.env[nombre];
  if (bruto === undefined || bruto === "") return defaultValue;
  const n = parseInt(bruto, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/** Devuelve un string limpio, o null si no hay nada. */
function textoONull(nombre) {
  const valor = process.env[nombre];
  return valor && valor.trim() ? valor.trim() : null;
}

/** Igual que `opcional`, pero limpia los espacios y nunca devuelve undefined. */
function texto(nombre, defaultValue) {
  const valor = process.env[nombre];
  return valor === undefined || valor === "" || !valor.trim()
    ? defaultValue
    : valor.trim();
}

// ---------------------------------------------------------------------------
// Validaciones
// ---------------------------------------------------------------------------

const isProduction = process.env.NODE_ENV === "production";

const PORT = entero("PORT", 3000);
const DATABASE_URL = obligatoria("DATABASE_URL");
const DATABASE_ADMIN_URL = textoONull("DATABASE_ADMIN_URL");

const JWT_SECRET = obligatoria("JWT_SECRET");
if (JWT_SECRET.length < (isProduction ? 64 : 32)) {
  fatal(`JWT_SECRET debe tener al menos ${isProduction ? 64 : 32} caracteres`);
}

// El chequeo de longitud solo no alcanza. Un secreto de ejemplo largo la pasa sin
// problema: "dev_secret_no_usar_en_produccion_cambiar" tiene 39 caracteres y
// arranca la app igual. Y con ese secreto el admin no existe: cualquiera que
// lea el repo (o adivine el nombre) firma su propio JWT con role "admin" y entra
// al panel, lee reservas, cambia estados y borra habitaciones. La revocacion por
// tokens_validos_desde tampoco ayuda, porque un token forjado tiene un iat de
// HOY, siempre posterior a la marca.
//
// Asique en produccion se rechazan los valores de ejemplo conocidos, y con
// ellos cualquier secreto que huela a plantilla. En desarrollo solo se avisa,
// para no romper el flujo local.
const jwtSecretMin = JWT_SECRET.toLowerCase();
const esEjemplo = SECRETOS_EJEMPLO.some((s) => jwtSecretMin.includes(s));
const pareceGenerico = /^(abc|xyz|test|demo|hotel|admin|jaquealrey)[a-z0-9_-]{0,12}$/.test(
  jwtSecretMin
);

if (esEjemplo || pareceGenerico || (isProduction && new Set(JWT_SECRET).size < 16)) {
  if (isProduction) {
    fatal(
      "JWT_SECRET es un valor de ejemplo o predecible. Con este secreto cualquiera puede " +
        "firmar su propio token de administrador.",
      "Generar uno con: openssl rand -hex 64"
    );
  }
  console.warn(
    "[Security] JWT_SECRET parece un valor de ejemplo. La app arranca porque es desarrollo, " +
      "pero NO sirve para produccion: con este secreto se puede forjar un token de administrador."
  );
}

// CORS
const allowedOrigins = opcional("CORS_ORIGIN", "http://localhost:4200")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (isProduction && allowedOrigins.length === 0) {
  fatal("CORS_ORIGIN es obligatorio en produccion");
}
if (isProduction && allowedOrigins.includes("*")) {
  fatal("CORS_ORIGIN no puede ser wildcard en produccion");
}
if (isProduction && allowedOrigins.some((origin) => {
  try {
    const parsed = new URL(origin);
    return parsed.protocol !== "https:" || parsed.origin !== origin;
  } catch {
    return true;
  }
})) {
  fatal("CORS_ORIGIN en produccion debe contener origenes HTTPS exactos, sin rutas ni barras finales");
}

const ADMIN_SECRET = textoONull("ADMIN_SECRET");
if (isProduction) {
  if (!ADMIN_SECRET || ADMIN_SECRET.length < 32) {
    fatal("ADMIN_SECRET debe estar configurado y tener al menos 32 caracteres en produccion");
  }
  const adminSecretMin = ADMIN_SECRET.toLowerCase();
  if (
    SECRETOS_EJEMPLO.some((s) => adminSecretMin.includes(s)) ||
    /^(abc|xyz|test|demo|hotel|admin|jaquealrey)[a-z0-9_-]{0,12}$/.test(adminSecretMin) ||
    new Set(ADMIN_SECRET).size < 12
  ) {
    fatal("ADMIN_SECRET parece un valor de ejemplo o predecible");
  }
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_EMAIL.trim()) {
    fatal("ADMIN_EMAIL debe configurarse explicitamente en produccion");
  }
  if (DATABASE_ADMIN_URL) {
    fatal("DATABASE_ADMIN_URL no debe estar configurado en el entorno runtime de produccion");
  }
}

const REDIS_URL = textoONull("REDIS_URL");
if (isProduction && REDIS_URL) {
  let redisUrl;
  try {
    redisUrl = new URL(REDIS_URL);
  } catch {
    fatal("REDIS_URL no es una URL valida");
  }
  const redisEsInterno = redisUrl.protocol === "redis:" && redisUrl.hostname === "jaquealrey-redis";
  if ((!redisEsInterno && redisUrl.protocol !== "rediss:") || !redisUrl.password) {
    fatal("REDIS_URL en produccion debe usar TLS y autenticacion (rediss://), salvo la red interna de Docker");
  }
}

// ---------------------------------------------------------------------------
// Configuracion congelada
// ---------------------------------------------------------------------------

module.exports = Object.freeze({
  // Runtime
  isProduction,
  port: PORT,

  // Base de datos. ADMIN_URL solo lo usan las migraciones (db/migrate.js): el rol
  // de la app (jaquealrey_app) no tiene CREATE a proposito, porque es el rol sin
  // privilegios que hace que RLS valga de verdad.
  db: Object.freeze({
    url: DATABASE_URL,
    adminUrl: DATABASE_ADMIN_URL,
    poolMax: entero("DB_POOL_MAX", 20),
  }),

  // Redis. Opcional: si no esta, el sistema opera sin cache.
  cache: Object.freeze({
    url: REDIS_URL,
    ttl: entero("CACHE_TTL", 60),

    // Namespace de las claves. La cache borra por prefijo y no con FLUSHDB, asi
    // que este valor tiene que ser el mismo en todas las instancias del mismo
    // proyecto: si dos-running con valores distintos, cada una invalida claves
    // que la otra no ve, y la cache queda inconsistente sin que se note.
    namespace: texto("CACHE_NAMESPACE", "jar"),
  }),

  // Auth
  auth: Object.freeze({
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: entero("JWT_EXPIRES_IN", 86400),
    adminEmail: opcional("ADMIN_EMAIL", "admin@jaquealrey.com").toLowerCase(),
    adminSecret: ADMIN_SECRET,
    bcryptRounds: entero("BCRYPT_ROUNDS", 12),
  }),

  // Reglas de negocio
  reglas: Object.freeze({
    horasCancelacion: entero("CANCELACION_HORAS", 24),
    // Cuanto se espera el pago de una reserva antes de liberarla sola. Sin esto,
    // una reserva abandonada a mitad del flujo de transferencia bloquea la
    // habitacion para siempre. 0 desactiva la liberacion automatica.
    horasExpiracionSinPago: entero("RESERVAS_EXPIRAR_HORAS", 48),
    // Cada cuanto corre el job que hace la limpieza. 15 min es un buen
    // compromiso: en temporada alta llegan reservas seguido y 15 min de
    // habitacion retenida por una reserva muerta es un costo real.
    intervaloExpiracionMs: entero("RESERVAS_EXPIRAR_CADA_MS", 15 * 60 * 1000),
  }),

  // WhatsApp Cloud API. Opcional: sin credenciales los avisos se omiten con un
  // warning y el sistema sigue operando (ver helpers/whatsappHelper.js).
  whatsapp: Object.freeze({
    token: textoONull("WHATSAPP_TOKEN"),
    phoneId: textoONull("WHATSAPP_PHONE_ID"),
    adminWhatsapp: textoONull("ADMIN_WHATSAPP"),
    hotelPhone: opcional("HOTEL_PHONE", "02942664320"),
  }),

  // Rate limiting. Todos por entorno, con defaults pensados para produccion.
  //
  // Dos razones para que sean numeros y no constantes en el codigo:
  //   1. Operacion: si el hotel tiene mas trafico del esperado, se ajusta sin
  //      tocar codigo ni volver a desplegar.
  //   2. La suite de regresion gasta ~17 POSTs a /api/reservas. Con el limite en
  //      20 no podia correr ni una vez por ventana de 15 minutos, y un
  //      "FAIL: 429" se confunde con un sistema roto.
  //
  // Se validan con `entero`: un valor mal escrito (RESERVA_MAX="muchas" o "-1")
  // cae al default en lugar de pasarle NaN a express-rate-limit.
  limites: Object.freeze({
    global: entero("GLOBAL_MAX", 300),
    login: entero("LOGIN_MAX", 10),
    registro: entero("REGISTER_MAX", 5),
    reserva: entero("RESERVA_MAX", 60),
    reservaPorEmail: entero("RESERVA_POR_EMAIL_MAX", 5),
    admin: entero("ADMIN_MAX", 300),
    usuario: entero("USUARIO_MAX", 30),
  }),

  http: Object.freeze({
    allowedOrigins: Object.freeze(allowedOrigins),
    // Saltos de proxy para reconstruir req.ip. Sin esto, detras de un proxy todos
    // los clientes comparten un contador de rate limit.
    trustProxyHops: entero("TRUST_PROXY_HOPS", 1),
  }),
});
