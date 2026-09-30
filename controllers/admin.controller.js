const { executeQuery } = require("../db");
const { success, error } = require("../utils/response");
const { emitReservaActualizada } = require("../socket/socket");
const {
  notifyReservaConfirmada,
  notifyReservaCanceladaPorHotel,
} = require("../helpers/whatsappHelper");

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

adminCtrl.getReservaById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await executeQuery(
      `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo as tipo,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email, c.telefono as cliente_telefono
       FROM Reserva r
       JOIN Habitacion h ON r.habitacion_id = h.id
       JOIN Cliente c ON r.cliente_id = c.id
       WHERE r.id = $1`,
      [id],
      { role: "admin" }
    );

    if (result.rows.length === 0) {
      return error(res, "Reserva no encontrada", 404);
    }

    return success(res, "Detalle de reserva", result.rows[0]);
  } catch (err) {
    next(err);
  }
};

adminCtrl.getReservas = async (req, res, next) => {
  try {
    const { estado, desde, hasta, pagina = 1, limite = 20 } = req.query;
    const offset = (parseInt(pagina, 10) - 1) * parseInt(limite, 10);

    let query = `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo as tipo,
                        c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email, c.telefono as cliente_telefono
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

    // Se lee antes de actualizar: hacen falta el estado anterior (para no
    // reavisar al huesped si el admin guardo el mismo estado dos veces) y los
    // datos de contacto para el aviso por WhatsApp.
    const anterior = await executeQuery(
      `SELECT r.estado,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.telefono as cliente_telefono,
              h.numero as habitacion_numero, h.nombre as habitacion_nombre
       FROM Reserva r
       JOIN Cliente c ON c.id = r.cliente_id
       JOIN Habitacion h ON h.id = r.habitacion_id
       WHERE r.id = $1`,
      [id],
      { role: "admin" }
    );

    if (anterior.rows.length === 0) {
      return error(res, "Reserva no encontrada", 404);
    }

    const previa = anterior.rows[0];

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
      [id, `Estado cambiado a ${estado}`, notas || null, req.ip || req.socket.remoteAddress],
      { role: "admin" }
    );

    emitReservaActualizada(result.rows[0]);

    // El huesped solo necesita aviso de los estados que le cambian algo. Se
    // dispara sin await a proposito: el panel del admin no debe esperar a
    // WhatsApp para responder, y sendTextMessage ya captura sus propios errores.
    if (estado !== previa.estado) {
      const contexto = {
        nombre: previa.cliente_nombre,
        apellido: previa.cliente_apellido,
        telefono: previa.cliente_telefono,
      };
      const habitacion = {
        numero: previa.habitacion_numero,
        nombre: previa.habitacion_nombre,
      };

      if (estado === "Confirmada") {
        notifyReservaConfirmada(result.rows[0], contexto, habitacion);
      } else if (estado === "Cancelada") {
        notifyReservaCanceladaPorHotel(result.rows[0], contexto, habitacion);
      }
    }

    return success(res, `Reserva ${estado.toLowerCase()}`, result.rows[0]);
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
