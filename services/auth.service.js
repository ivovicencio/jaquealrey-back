/**
 * Auth: registro del admin, login, logout y cambio de contrasena.
 *
 * El huesped NO tiene cuenta. Este service existe solo para el personal del hotel
 * (hoy, una unica persona).
 *
 * Decision de seguridad que atraviesa el archivo: el rol se decide SIEMPRE con
 * el email que viene de la BASE, nunca con el que escribio el visitante.
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { AppError } = require("../utils/AppError");
const { registrarFallo, limpiarFallo } = require("../middlewares/rateLimiter");
const config = require("../config");
const clienteService = require("./cliente.service");
const { desconectarCliente } = require("../socket/socket");

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

function mensajePasswordDebil() {
  return "La contrasena debe tener al menos 8 caracteres, una mayuscula, una minuscula y un numero";
}

function firmar(user, role) {
  return jwt.sign({ id: user.id, email: user.email, role }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn,
  });
}

/**
 * Registro. Solo crea la cuenta del personal del hotel: exige el ADMIN_SECRET y
 * que el email sea exactamente el del admin configurado.
 */
async function registrar(body) {
  const { nombre, apellido, telefono, email, password } = body;

  if (!config.auth.adminSecret || body.admin_secret !== config.auth.adminSecret) {
    throw new AppError("No autorizado", 403);
  }

  if (String(email).toLowerCase() !== config.auth.adminEmail) {
    throw new AppError("Solo se puede crear la cuenta de administrador del hotel", 403);
  }

  if (!PASSWORD_REGEX.test(password)) {
    throw new AppError(mensajePasswordDebil(), 400);
  }

  if (password.length > 72) {
    throw new AppError("La contrasena no puede tener mas de 72 caracteres", 400);
  }

  const existente = await clienteService.buscarPorEmail(email);
  if (existente) throw new AppError("El email ya esta registrado", 409);

  const hash = await bcrypt.hash(password, config.auth.bcryptRounds);
  const user = await clienteService.crearAdmin({
    nombre,
    apellido,
    telefono,
    email,
    passwordHasheado: hash,
  });

  // Se marca antes de firmar: el token que se emite ahora tiene que ser el
  // primero valido bajo la regla de revocacion.
  await clienteService.revocarTokens(user.id);

  return { user, token: firmar(user, "admin") };
}

/**
 * Login.
 *
 * Sesion unica: al entrar se mueve la marca de revocacion y quedan invalidados
 * los tokens anteriores. Es el trade-off de tener revocacion de verdad: si el
 * personal se loguea en otro navegador, este pierde la sesion y tiene que entrar
 * de nuevo. Para un panel con un solo admin es lo razonable.
 */
async function login(body, req) {
  const { email, password } = body;

  const user = await clienteService.buscarPorEmail(email, { conPassword: true });

  if (!user) {
    // Hash señuelo: evitamos que el tiempo de respuesta revele si el email existe.
    //bcrypt.compare es lento (~100-300ms), si no existe el usuario, respondemos
    //instantáneamente, creando un canal lateral de tiempo.
    await bcrypt.compare("dummy_password", "$2b$10$FakeHashForTimingConsistency1234567890");
    registrarFallo(req);
    throw new AppError("Email o contrasena incorrectos", 401);
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    registrarFallo(req);
    throw new AppError("Email o contrasena incorrectos", 401);
  }

  limpiarFallo(req);

  // El rol se decide con el email que viene de la BASE, nunca con el que escribio
  // el visitante, y la comparacion es insensible a mayusculas.
  const role = String(user.email).toLowerCase() === config.auth.adminEmail ? "admin" : "cliente";

  if (role === "admin") {
    await clienteService.revocarTokens(user.id);
  }

  const { password: _omitido, ...userData } = user;
  return { user: userData, token: firmar(user, role) };
}

/**
 * Logout del lado del servidor. Sin esto, cerrar sesion en la UI era solo borrar
 * el token de este navegador: el token seguia sirviendo hasta vencer.
 */
async function logout(userId) {
  // Un segundo por delante del reloj. La revocacion se compara en segundos
  // enteros, asi que si el login y el logout caen en el mismo segundo la marca
  // seria igual al iat del token y este seguiria sirviendo. Adelantarla un
  // segundo cierra ese hueco sin tocar los tokens de otras sesiones.
  await clienteService.revocarTokens(userId, {
    role: "admin",
    userId,
    adelanteSegundos: 1,
  });

  // La revocacion de la base mata la API, pero no la conexion de socket: sin
  // esto el admin que acaba de hacer logout sigue en la sala `admins` recibiendo
  // las reservas de los huespedes en tiempo real. Primero se cierran las
  // conexiones y despues se revoca, para que ningun mensaje se cuelgue en
  // transito con un token ya invalidado.
  desconectarCliente(userId);
}

async function cambiarPassword({ password_actual, password_nueva }, { userId, role }) {
  if (!PASSWORD_REGEX.test(password_nueva)) {
    throw new AppError(`La nueva ${mensajePasswordDebil().toLowerCase()}`, 400);
  }

  if (password_actual === password_nueva) {
    throw new AppError("La nueva contrasena debe ser diferente a la actual", 400);
  }

  const user = await clienteService.obtenerPassword(userId, { role, userId });
  if (!user) throw new AppError("Usuario no encontrado", 404);

  const valid = await bcrypt.compare(password_actual, user.password);
  if (!valid) throw new AppError("La contrasena actual es incorrecta", 401);

  const hash = await bcrypt.hash(password_nueva, config.auth.bcryptRounds);
  await clienteService.actualizarPassword(userId, hash, { role, userId });

  // Cambiar la contrasena corta las demas sesiones abiertas. Si el cambio viene de
  // que la contrasena se filtro, dejar vivas las sesiones viejas seria dejarle la
  // puerta abierta a quien la robo.
  await clienteService.revocarTokens(userId, { role, userId });

  return "Contrasena actualizada exitosamente. Volve a iniciar sesion.";
}

module.exports = { registrar, login, logout, cambiarPassword };
