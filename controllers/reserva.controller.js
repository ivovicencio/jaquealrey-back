const { executeQuery } = require("../db");
const { success, error } = require("../utils/response");
const { generateCode } = require("../utils/generateCode");
const { emitNuevaReserva, emitReservaActualizada } = require("../socket/socket");
const { notifyNewReserva } = require("../helpers/whatsappHelper");

const reservaCtrl = {};

reservaCtrl.create = async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, email, habitacion_id, fecha_entrada, fecha_salida, huespedes, notas } = req.body;

    if (new Date(fecha_entrada) < new Date(new Date().toDateString())) {
      return error(res, "La fecha de entrada no puede ser anterior a hoy", 400);
    }
    if (new Date(fecha_salida) <= new Date(fecha_entrada)) {
      return error(res, "La fecha de salida debe ser posterior a la de entrada", 400);
    }

    const habCheck = await executeQuery("SELECT id, precio_noche, capacidad_max FROM Habitacion WHERE id = $1 AND activa = true", [habitacion_id], { role: "public" });
    if (habCheck.rows.length === 0) {
      return error(res, "Habitación no encontrada o no disponible", 404);
    }
    const habitacion = habCheck.rows[0];
    if (huespedes > habitacion.capacidad_max) {
      return error(res, `La habitación tiene capacidad máxima de ${habitacion.capacidad_max} huéspedes`, 400);
    }

    const disponible = await executeQuery("SELECT habitacion_disponible($1, $2, $3)", [habitacion_id, fecha_entrada, fecha_salida], { role: "public" });
    if (!disponible.rows[0].habitacion_disponible) {
      return error(res, "La habitación no está disponible en las fechas seleccionadas", 409);
    }

    let clienteResult = await executeQuery("SELECT id, nombre, apellido FROM buscar_cliente_por_email($1)", [email]);
    let clienteId;
    let clienteNombre = nombre;
    let clienteApellido = apellido || "";

    if (clienteResult.rows.length === 0) {
      const tempPassword = require("crypto").randomBytes(6).toString("hex");
      const bcrypt = require("bcryptjs");
      const salt = await bcrypt.genSalt(12);
      const hash = await bcrypt.hash(tempPassword, salt);

      clienteResult = await executeQuery(
        `INSERT INTO Cliente (nombre, apellido, telefono, email, password)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, nombre, apellido`,
        [nombre, apellido || "", telefono, email, hash]
      );
      clienteId = clienteResult.rows[0].id;
      clienteNombre = clienteResult.rows[0].nombre;
      clienteApellido = clienteResult.rows[0].apellido || "";
    } else {
      clienteId = clienteResult.rows[0].id;
      clienteNombre = clienteResult.rows[0].nombre;
      clienteApellido = clienteResult.rows[0].apellido || "";
    }

    const noches = Math.ceil(
      (new Date(fecha_salida) - new Date(fecha_entrada)) / (1000 * 60 * 60 * 24)
    );
    const precio_total = noches * parseFloat(habitacion.precio_noche);
    const codigo = generateCode();

    const reservaResult = await executeQuery(
      `INSERT INTO Reserva (codigo, cliente_id, habitacion_id, fecha_entrada, fecha_salida, huespedes, precio_total, notas, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pendiente')
       RETURNING *`,
      [codigo, clienteId, habitacion_id, fecha_entrada, fecha_salida, huespedes, precio_total, notas || null]
    );

    await executeQuery(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'Creada', $2, 'cliente', $3)`,
      [reservaResult.rows[0].id, `Reserva creada por ${clienteNombre} ${clienteApellido}`, req.ip || req.connection.remoteAddress]
    );

    const reservaNueva = reservaResult.rows[0];
    emitNuevaReserva(reservaNueva);
    notifyNewReserva(reservaNueva, { nombre, apellido, email, telefono }, habitacion);

    return success(res, "Reserva creada exitosamente", reservaNueva, 201);
  } catch (err) {
    next(err);
  }
};

reservaCtrl.getMisReservas = async (req, res, next) => {
  try {
    const result = await executeQuery(
      `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo
       FROM Reserva r
       JOIN Habitacion h ON r.habitacion_id = h.id
       WHERE r.cliente_id = $1
       ORDER BY r.fecha_entrada DESC`,
      [req.userId],
      { role: req.role, userId: req.userId }
    );

    return success(res, "Mis reservas", result.rows);
  } catch (err) {
    next(err);
  }
};

reservaCtrl.getById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await executeQuery(
      `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email, c.telefono as cliente_telefono
       FROM Reserva r
       JOIN Habitacion h ON r.habitacion_id = h.id
       JOIN Cliente c ON r.cliente_id = c.id
       WHERE r.id = $1`,
      [id],
      { role: req.role, userId: req.userId }
    );

    if (result.rows.length === 0) {
      return error(res, "Reserva no encontrada", 404);
    }

    const reserva = result.rows[0];
    if (req.role !== "admin" && reserva.cliente_id !== req.userId) {
      return error(res, "No tienes permiso para ver esta reserva", 403);
    }

    return success(res, "Detalle de reserva", reserva);
  } catch (err) {
    next(err);
  }
};

reservaCtrl.cancel = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;

    const result = await executeQuery(
      "SELECT id, cliente_id, estado FROM Reserva WHERE id = $1",
      [id],
      { role: req.role, userId: req.userId }
    );

    if (result.rows.length === 0) {
      return error(res, "Reserva no encontrada", 404);
    }

    const reserva = result.rows[0];

    if (req.role !== "admin" && reserva.cliente_id !== req.userId) {
      return error(res, "No tienes permiso para cancelar esta reserva", 403);
    }

    if (!["Pendiente", "Confirmada"].includes(reserva.estado)) {
      return error(res, "Solo se pueden cancelar reservas Pendientes o Confirmadas", 400);
    }

    const updated = await executeQuery(
      "UPDATE Reserva SET estado = 'Cancelada' WHERE id = $1 RETURNING *",
      [id],
      { role: req.role }
    );

    await executeQuery(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'Cancelada', $2, $3, $4)`,
      [id, motivo || "Cancelación solicitada", req.role === "admin" ? "admin" : "cliente", req.ip || req.connection.remoteAddress]
    );

    emitReservaActualizada(updated.rows[0]);

    return success(res, "Reserva cancelada", updated.rows[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = reservaCtrl;
