const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { executeQuery, withTransaction } = require("../db");
const { success, error } = require("../utils/response");
const { generateCode } = require("../utils/generateCode");
const { emitNuevaReserva, emitReservaActualizada } = require("../socket/socket");
const {
  notifyNewReserva,
  notifyCancelacionHuesped,
  HOTEL_PHONE,
} = require("../helpers/whatsappHelper");

const reservaCtrl = {};

const HORAS_CANCELACION = Number(process.env.CANCELACION_HORAS || 24);
const TZ_HOTEL = -3; // America/Argentina no aplica horario de verano desde 2009
const TELEFONO_HOTEL = HOTEL_PHONE;

// pg devuelve las columnas DATE como Date a la medianoche local, no como string.
function fechaISO(valor) {
  if (valor instanceof Date) {
    const mes = String(valor.getMonth() + 1).padStart(2, "0");
    const dia = String(valor.getDate()).padStart(2, "0");
    return `${valor.getFullYear()}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

function horasHastaEntrada(fechaEntrada) {
  const medianoche = Date.parse(`${fechaISO(fechaEntrada)}T00:00:00Z`);
  if (Number.isNaN(medianoche)) return 0;
  return (medianoche - (Date.now() + TZ_HOTEL * 3600000)) / 3600000;
}

function puedeCancelar(estado, fechaEntrada) {
  return ["Pendiente", "Confirmada"].includes(estado) && horasHastaEntrada(fechaEntrada) > HORAS_CANCELACION;
}

// El huesped no tiene cuenta: se identifica con el codigo de reserva + su email.
// El WHERE exige ambos datos, asi que un email incorrecto no revela nada.
// No se devuelven email ni telefono: la consulta publica no los necesita.
const CONSULTA_POR_CODIGO = `
  SELECT r.id, r.codigo, r.fecha_entrada, r.fecha_salida, r.huespedes,
         r.precio_total, r.estado, r.notas, r.created_at,
         h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo,
         c.nombre as cliente_nombre, c.apellido as cliente_apellido
  FROM Reserva r
  JOIN Habitacion h ON r.habitacion_id = h.id
  JOIN Cliente c ON r.cliente_id = c.id
  WHERE UPPER(r.codigo) = UPPER($1) AND LOWER(c.email) = LOWER($2)`;

reservaCtrl.consultar = async (req, res, next) => {
  try {
    const codigo = String(req.query.codigo || "").trim();
    const email = String(req.query.email || "").trim();

    if (!codigo || !email) {
      return error(res, "Debe indicar el codigo de reserva y el email", 400);
    }

    const result = await executeQuery(CONSULTA_POR_CODIGO, [codigo, email], { role: "admin" });

    if (result.rows.length === 0) {
      return error(res, "No encontramos una reserva con ese codigo y email", 404);
    }

    const reserva = result.rows[0];
    const horas = horasHastaEntrada(reserva.fecha_entrada);

    return success(res, "Reserva encontrada", {
      ...reserva,
      puede_cancelar: puedeCancelar(reserva.estado, reserva.fecha_entrada),
      horas_para_cancelar: Math.max(0, Math.floor(horas)),
    });
  } catch (err) {
    next(err);
  }
};

reservaCtrl.cancelarPublica = async (req, res, next) => {
  try {
    const { codigo, email, motivo } = req.body;
    const codigoLimpio = String(codigo || "").trim();
    const emailLimpio = String(email || "").trim();

    if (!codigoLimpio || !emailLimpio) {
      return error(res, "Debe indicar el codigo de reserva y el email", 400);
    }

    // Una sola transaccion: el lock se mantiene hasta el UPDATE, asi dos
    // intentos simultaneos no pueden cancelar dos veces la misma reserva.
    const resultado = await withTransaction(async (client) => {
      const encontrada = await client.query(`${CONSULTA_POR_CODIGO} FOR UPDATE OF r`, [
        codigoLimpio,
        emailLimpio,
      ]);

      if (encontrada.rows.length === 0) {
        return { motivo: 404 };
      }

      const reserva = encontrada.rows[0];

      if (!["Pendiente", "Confirmada"].includes(reserva.estado)) {
        return { motivo: "estado", estado: reserva.estado };
      }

      if (horasHastaEntrada(reserva.fecha_entrada) <= HORAS_CANCELACION) {
        return { motivo: "plazo" };
      }

      const updated = await client.query(
        "UPDATE Reserva SET estado = 'Cancelada', updated_at = NOW() WHERE id = $1 RETURNING *",
        [reserva.id]
      );

      await client.query(
        `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
         VALUES ($1, 'Cancelada', $2, 'cliente', $3)`,
        [reserva.id, motivo || "Cancelacion solicitada por el huesped", req.ip || req.socket.remoteAddress]
      );

      // Datos de contacto solo para el aviso al hotel. Se piden por separado
      // porque la consulta publica del codigo no expone telefono ni email.
      const contacto = await client.query(
        `SELECT c.nombre as cliente_nombre, c.apellido as cliente_apellido,
                c.telefono as cliente_telefono, c.email as cliente_email,
                h.numero as habitacion_numero, h.nombre as habitacion_nombre
         FROM Reserva r
         JOIN Cliente c ON c.id = r.cliente_id
         JOIN Habitacion h ON h.id = r.habitacion_id
         WHERE r.id = $1`,
        [reserva.id]
      );

      const datos = contacto.rows[0];

      return {
        reserva: updated.rows[0],
        datos: {
          cliente: {
            nombre: datos.cliente_nombre,
            apellido: datos.cliente_apellido,
            telefono: datos.cliente_telefono,
            email: datos.cliente_email,
          },
          habitacion: {
            numero: datos.habitacion_numero,
            nombre: datos.habitacion_nombre,
          },
        },
      };
    }, { role: "admin" });

    if (resultado.motivo === 404) {
      return error(res, "No encontramos una reserva con ese codigo y email", 404);
    }
    if (resultado.motivo === "estado") {
      return error(res, `La reserva ya esta ${resultado.estado.toLowerCase()}`, 400);
    }
    if (resultado.motivo === "plazo") {
      return error(
        res,
        `Para cancelaciones con menos de ${HORAS_CANCELACION} horas de anticipacion, contactanos al ${TELEFONO_HOTEL}`,
        400
      );
    }

    emitReservaActualizada(resultado.reserva);

    // El hotel tiene que enterarse de la cancelacion: la habitacion vuelve a
    // quedar libre para esas fechas y puede ofrecerla a otro huesped.
    if (resultado.datos) {
      notifyCancelacionHuesped(resultado.reserva, resultado.datos.cliente, resultado.datos.habitacion, motivo);
    }

    return success(res, "Reserva cancelada", resultado.reserva);
  } catch (err) {
    next(err);
  }
};

reservaCtrl.create = async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, email, habitacion_id, fecha_entrada, fecha_salida, huespedes, notas } = req.body;

    const hoy = new Date().toISOString().slice(0, 10);
    if (fecha_entrada < hoy) {
      return error(res, "La fecha de entrada no puede ser anterior a hoy", 400);
    }
    if (fecha_salida <= fecha_entrada) {
      return error(res, "La fecha de salida debe ser posterior a la de entrada", 400);
    }

    // numero y nombre se piden porque el aviso de WhatsApp al hotel los muestra.
    const habCheck = await executeQuery("SELECT id, numero, nombre, precio_noche, capacidad_max FROM Habitacion WHERE id = $1 AND activa = true", [habitacion_id], { role: "public" });
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
      const tempPassword = crypto.randomBytes(6).toString("hex");
      const salt = await bcrypt.genSalt(12);
      const hash = await bcrypt.hash(tempPassword, salt);

      clienteResult = await executeQuery(
        `INSERT INTO Cliente (nombre, apellido, telefono, email, password)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, nombre, apellido`,
        [nombre, apellido || "", telefono, email, hash],
        { role: "admin" }
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
      [codigo, clienteId, habitacion_id, fecha_entrada, fecha_salida, huespedes, precio_total, notas || null],
      { role: "admin" }
    );

    await executeQuery(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'Creada', $2, 'cliente', $3)`,
      [reservaResult.rows[0].id, `Reserva creada por ${clienteNombre} ${clienteApellido}`, req.ip || req.socket.remoteAddress],
      { role: "admin" }
    );

    const reservaNueva = reservaResult.rows[0];
    emitNuevaReserva(reservaNueva);
    notifyNewReserva(reservaNueva, { nombre, apellido, email, telefono }, habitacion);

    return success(res, "Reserva creada exitosamente", reservaNueva, 201);
  } catch (err) {
    // 23P01 = exclusion_violation. El SELECT de disponibilidad de arriba es
    // solo una cortesia: entre ese chequeo y el INSERT hay una ventana en la
    // que otra reserva se adelanta. Cuando eso pasa, la constraint
    // reserva_sin_solapamiento (que es la garantia real) rechaza el INSERT.
    // Sin esto, al huesped le llegaba un 500 de error del servidor en vez de
    // un 409 con el mensaje que ya conoce: "la habitacion no esta disponible".
    if (err && err.code === "23P01") {
      return error(res, "La habitación no está disponible en las fechas seleccionadas", 409);
    }
    next(err);
  }
};

module.exports = reservaCtrl;
