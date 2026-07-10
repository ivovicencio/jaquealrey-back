const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { executeQuery } = require("../db");
const { success, error } = require("../utils/response");

const authCtrl = {};

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = parseInt(process.env.JWT_EXPIRES_IN, 10) || 86400;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@jaquealrey.com";
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

authCtrl.register = async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, email, password } = req.body;

    if (!PASSWORD_REGEX.test(password)) {
      return error(res, "La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número", 400);
    }

    const existing = await executeQuery("SELECT id FROM buscar_cliente_por_email($1)", [email]);
    if (existing.rows.length > 0) {
      return error(res, "El email ya está registrado", 409);
    }

    const isAdminEmail = email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
    if (isAdminEmail && ADMIN_SECRET) {
      if (req.body.admin_secret !== ADMIN_SECRET) {
        return error(res, "Código de administrador inválido", 403);
      }
    }

    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(password, salt);

    const result = await executeQuery(
      `INSERT INTO Cliente (nombre, apellido, telefono, email, password)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nombre, apellido, email, created_at`,
      [nombre, apellido || "", telefono, email, hash]
    );

    const user = result.rows[0];
    const role = isAdminEmail ? "admin" : "cliente";
    const token = jwt.sign({ id: user.id, email: user.email, role }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    return success(res, "Registro exitoso", { user, token }, 201);
  } catch (err) {
    next(err);
  }
};

authCtrl.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const result = await executeQuery(
      "SELECT id, nombre, apellido, email, password, created_at FROM buscar_cliente_por_email($1)",
      [email]
    );

    if (result.rows.length === 0) {
      return error(res, "Email o contraseña incorrectos", 401);
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return error(res, "Email o contraseña incorrectos", 401);
    }

    const role = email === ADMIN_EMAIL ? "admin" : "cliente";
    const token = jwt.sign({ id: user.id, email: user.email, role }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    const { password: _, ...userData } = user;
    return success(res, "Inicio de sesión exitoso", { user: userData, token });
  } catch (err) {
    next(err);
  }
};

authCtrl.changePassword = async (req, res, next) => {
  try {
    const { password_actual, password_nueva } = req.body;

    if (!PASSWORD_REGEX.test(password_nueva)) {
      return error(res, "La nueva contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número", 400);
    }

    if (password_actual === password_nueva) {
      return error(res, "La nueva contraseña debe ser diferente a la actual", 400);
    }

    const result = await executeQuery(
      "SELECT id, password FROM Cliente WHERE id = $1",
      [req.userId],
      { role: req.role, userId: req.userId }
    );

    if (result.rows.length === 0) {
      return error(res, "Usuario no encontrado", 404);
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password_actual, user.password);

    if (!valid) {
      return error(res, "La contraseña actual es incorrecta", 401);
    }

    const salt = await bcrypt.genSalt(12);
    const hash = await bcrypt.hash(password_nueva, salt);

    await executeQuery(
      "UPDATE Cliente SET password = $1 WHERE id = $2",
      [hash, req.userId],
      { role: req.role, userId: req.userId }
    );

    return success(res, "Contraseña actualizada exitosamente");
  } catch (err) {
    next(err);
  }
};

module.exports = authCtrl;
