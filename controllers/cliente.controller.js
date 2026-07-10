const { executeQuery } = require("../db");
const { success, error } = require("../utils/response");

const clienteCtrl = {};

clienteCtrl.getById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (req.role !== "admin" && parseInt(id, 10) !== req.userId) {
      return error(res, "No tienes permiso para ver este perfil", 403);
    }

    const result = await executeQuery(
      "SELECT id, nombre, apellido, telefono, email, created_at FROM Cliente WHERE id = $1",
      [id],
      { role: req.role, userId: req.userId }
    );

    if (result.rows.length === 0) {
      return error(res, "Cliente no encontrado", 404);
    }

    return success(res, "Perfil del cliente", result.rows[0]);
  } catch (err) {
    next(err);
  }
};

clienteCtrl.update = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (req.role !== "admin" && parseInt(id, 10) !== req.userId) {
      return error(res, "No tienes permiso para actualizar este perfil", 403);
    }

    const { nombre, apellido, telefono } = req.body;

    const result = await executeQuery(
      `UPDATE Cliente
       SET nombre = COALESCE($1, nombre),
           apellido = COALESCE($2, apellido),
           telefono = COALESCE($3, telefono)
       WHERE id = $4
       RETURNING id, nombre, apellido, telefono, email, created_at`,
      [nombre, apellido, telefono, id],
      { role: req.role === "admin" ? "admin" : "public", userId: req.userId }
    );

    if (result.rows.length === 0) {
      return error(res, "Cliente no encontrado", 404);
    }

    return success(res, "Perfil actualizado", result.rows[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = clienteCtrl;
