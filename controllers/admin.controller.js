const { executeQuery } = require("../db");
const { success, error } = require("../utils/response");
const { emitReservaActualizada } = require("../socket/socket");

const adminCtrl = {};

adminCtrl.getDashboard = async (_req, res, next) => {
  try {
    const adminCtx = { role: "admin" };
    const [reservasActivas, reservasProximas, ingresosMensuales, totalClientes, totalHabitaciones] = await Promise.all([
      executeQuery(
        "SELECT COUNT(*)::int FROM Reserva WHERE estado IN ('Pendiente', 'Confirmada')",
        [],
        adminCtx
      ),
      executeQuery(
        `SELECT COUNT(*)::int FROM Reserva
         WHERE estado IN ('Pendiente', 'Confirmada')
           AND fecha_entrada >= CURRENT_DATE
           AND fecha_entrada <= CURRENT_DATE + INTERVAL '7 days'`,
        [],
        adminCtx
      ),
      executeQuery(
        `SELECT COALESCE(SUM(precio_total), 0)::float as total
         FROM Reserva
         WHERE estado IN ('Confirmada', 'Completada')
           AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
           AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)`,
        [],
        adminCtx
      ),
      executeQuery("SELECT COUNT(*)::int FROM Cliente", [], adminCtx),
      executeQuery("SELECT COUNT(*)::int FROM Habitacion WHERE activa = true", [], adminCtx),
    ]);

    return success(res, "Dashboard", {
      reservas_activas: reservasActivas.rows[0].count,
      reservas_proximas_7_dias: reservasProximas.rows[0].count,
      ingresos_mes_actual: ingresosMensuales.rows[0].total,
      total_clientes: totalClientes.rows[0].count,
      habitaciones_activas: totalHabitaciones.rows[0].count,
    });
  } catch (err) {
    next(err);
  }
};

adminCtrl.getReservas = async (req, res, next) => {
  try {
    const { estado, desde, hasta, pagina = 1, limite = 20 } = req.query;
    const offset = (parseInt(pagina, 10) - 1) * parseInt(limite, 10);

    let query = `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre,
                        c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email
                 FROM Reserva r
                 JOIN Habitacion h ON r.habitacion_id = h.id
                 JOIN Cliente c ON r.cliente_id = c.id
                 WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (estado) {
      query += ` AND r.estado = $${paramIdx++}`;
      params.push(estado);
    }
    if (desde) {
      query += ` AND r.fecha_entrada >= $${paramIdx++}`;
      params.push(desde);
    }
    if (hasta) {
      query += ` AND r.fecha_salida <= $${paramIdx++}`;
      params.push(hasta);
    }

    const countResult = await executeQuery(
      `SELECT COUNT(*)::int FROM (${query}) sub`,
      params,
      { role: "admin" }
    );

    query += " ORDER BY r.fecha_entrada DESC";
    query += ` LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(parseInt(limite, 10), offset);

    const result = await executeQuery(query, params, { role: "admin" });

    return success(res, "Listado de reservas", {
      reservas: result.rows,
      total: countResult.rows[0].count,
      pagina: parseInt(pagina, 10),
      total_paginas: Math.ceil(countResult.rows[0].count / parseInt(limite, 10)),
    });
  } catch (err) {
    next(err);
  }
};

adminCtrl.updateReservaEstado = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { estado, notas } = req.body;

    const valido = ["Pendiente", "Confirmada", "Cancelada", "Completada"];
    if (!valido.includes(estado)) {
      return error(res, `Estado inválido. Valores: ${valido.join(", ")}`, 400);
    }

    const result = await executeQuery(
      "UPDATE Reserva SET estado = $1 WHERE id = $2 RETURNING *",
      [estado, id],
      { role: "admin" }
    );

    if (result.rows.length === 0) {
      return error(res, "Reserva no encontrada", 404);
    }

    await executeQuery(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, $2, $3, 'admin', $4)`,
      [id, `Estado cambiado a ${estado}`, notas || null, req.ip || req.connection.remoteAddress]
    );

    emitReservaActualizada(result.rows[0]);

    return success(res, `Reserva ${estado.toLowerCase()}`, result.rows[0]);
  } catch (err) {
    next(err);
  }
};

adminCtrl.getClientes = async (req, res, next) => {
  try {
    const { pagina = 1, limite = 20 } = req.query;
    const offset = (parseInt(pagina, 10) - 1) * parseInt(limite, 10);

    const countResult = await executeQuery("SELECT COUNT(*)::int FROM Cliente", [], { role: "admin" });

    const result = await executeQuery(
      `SELECT id, nombre, apellido, telefono, email, created_at
       FROM Cliente
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limite, 10), offset],
      { role: "admin" }
    );

    return success(res, "Listado de clientes", {
      clientes: result.rows,
      total: countResult.rows[0].count,
      pagina: parseInt(pagina, 10),
      total_paginas: Math.ceil(countResult.rows[0].count / parseInt(limite, 10)),
    });
  } catch (err) {
    next(err);
  }
};

adminCtrl.getClienteById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const cliente = await executeQuery(
      "SELECT id, nombre, apellido, telefono, email, created_at FROM Cliente WHERE id = $1",
      [id],
      { role: "admin" }
    );

    if (cliente.rows.length === 0) {
      return error(res, "Cliente no encontrado", 404);
    }

    const reservas = await executeQuery(
      `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre
       FROM Reserva r
       JOIN Habitacion h ON r.habitacion_id = h.id
       WHERE r.cliente_id = $1
       ORDER BY r.fecha_entrada DESC`,
      [id],
      { role: "admin" }
    );

    return success(res, "Detalle del cliente", {
      ...cliente.rows[0],
      reservas: reservas.rows,
    });
  } catch (err) {
    next(err);
  }
};

adminCtrl.getHistorial = async (req, res, next) => {
  try {
    const { pagina = 1, limite = 50 } = req.query;
    const offset = (parseInt(pagina, 10) - 1) * parseInt(limite, 10);

    const countResult = await executeQuery("SELECT COUNT(*)::int FROM HistorialReserva", [], { role: "admin" });

    const result = await executeQuery(
      `SELECT h.*, r.codigo as reserva_codigo
       FROM HistorialReserva h
       JOIN Reserva r ON h.reserva_id = r.id
       ORDER BY h.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limite, 10), offset],
      { role: "admin" }
    );

    return success(res, "Historial de cambios", {
      historial: result.rows,
      total: countResult.rows[0].count,
      pagina: parseInt(pagina, 10),
      total_paginas: Math.ceil(countResult.rows[0].count / parseInt(limite, 10)),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = adminCtrl;
