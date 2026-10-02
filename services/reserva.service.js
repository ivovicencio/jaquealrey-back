/**
 * Reservas: el corazon del sistema.
 *
 * Concentra tres cosas que es importante tener juntas porque se condicionan
 * entre si:
 *
 *  1. Disponibilidad. La garantia real de que una habitacion no se vende dos
 *     veces es la constraint `reserva_sin_solapamiento` de la base, NO el SELECT
 *     de disponibilidad. El SELECT es una cortesia para poder devolver un 409
 *     con un mensaje claro; la constraint es lo que cierra la ventana de carrera
 *     entre ese SELECT y el INSERT.
 *
 *  2. Atomicidad. La reserva y su fila de historial se escriben juntas. Si el
 *     historial fallara por separado, quedaria una reserva creada sin ninguna
 *     trazabilidad, que es justo el registro que sirve para reconstruir que paso.
 *
 *  3. Reglas de cancelacion. El huesped cancela sin cuenta: se identifica con
 *     codigo de reserva + email, y hay una ventana de anticipacion minima.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const { executeQuery, withTransaction, ROL } = require("../db");
const { AppError } = require("../utils/AppError");
const { generateCode } = require("../utils/generateCode");
const { emitNuevaReserva, emitReservaActualizada } = require("../socket/socket");
const {
  notifyNewReserva,
  notifyCancelacionHuesped,
  notifyReservaConfirmada,
  notifyReservaCanceladaPorHotel,
  notifyPagoReportado,
} = require("../helpers/whatsappHelper");
const config = require("../config");
const clienteService = require("./cliente.service");

const HORAS_CANCELACION = config.reglas.horasCancelacion;
const TELEFONO_HOTEL = config.whatsapp.hotelPhone;

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

// pg devuelve las columnas DATE como Date a la medianoche local, no como string.
function fechaISO(valor) {
  if (valor instanceof Date) {
    const mes = String(valor.getMonth() + 1).padStart(2, "0");
    const dia = String(valor.getDate()).padStart(2, "0");
    return `${valor.getFullYear()}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

// America/Argentina no aplica horario de verano desde 2009, asi que el offset es fijo.
const TZ_HOTEL = -3;

/** Horas que faltan hasta la medianoche de la fecha de entrada. Negativo = ya paso. */
function horasHastaEntrada(fechaEntrada) {
  const medianoche = Date.parse(`${fechaISO(fechaEntrada)}T00:00:00Z`);
  if (Number.isNaN(medianoche)) return 0;
  return (medianoche - (Date.now() + TZ_HOTEL * 3600000)) / 3600000;
}

/** El huesped puede cancelar mientras la reserva siga vigente y falte tiempo. */
function puedeCancelar(estado, fechaEntrada) {
  return (
    ["Pendiente", "Confirmada"].includes(estado) &&
    horasHastaEntrada(fechaEntrada) > HORAS_CANCELACION
  );
}

function nochesEntre(desde, hasta) {
  return Math.ceil((new Date(hasta) - new Date(desde)) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Consulta publica por codigo
// ---------------------------------------------------------------------------

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

/** Consulta del huesped por codigo + email. */
async function consultarPorCodigo(codigo, email) {
  const result = await executeQuery(CONSULTA_POR_CODIGO, [codigo, email], ROL.ADMIN);

  if (result.rows.length === 0) {
    throw new AppError("No encontramos una reserva con ese codigo y email", 404);
  }

  const reserva = result.rows[0];
  const horas = horasHastaEntrada(reserva.fecha_entrada);

  return {
    ...reserva,
    puede_cancelar: puedeCancelar(reserva.estado, reserva.fecha_entrada),
    horas_para_cancelar: Math.max(0, Math.floor(horas)),
  };
}

/** Datos de contacto, para los avisos. Se piden aparte porque la consulta publica no los expone. */
async function obtenerContacto(reservaId) {
  const result = await executeQuery(
    `SELECT c.nombre as cliente_nombre, c.apellido as cliente_apellido,
            c.telefono as cliente_telefono, c.email as cliente_email,
            h.numero as habitacion_numero, h.nombre as habitacion_nombre
     FROM Reserva r
     JOIN Cliente c ON c.id = r.cliente_id
     JOIN Habitacion h ON h.id = r.habitacion_id
     WHERE r.id = $1`,
    [reservaId],
    ROL.ADMIN
  );

  const datos = result.rows[0];
  if (!datos) return null;

  return {
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
  };
}

// ---------------------------------------------------------------------------
// Crear reserva
// ---------------------------------------------------------------------------

/**
 * Hashea la credencial muerta de un huesped recien creado, fuera del flujo de la
 * request.
 *
 * La contrasena es aleatoria y no se muestra a nadie: existe unicamente porque
 * `Cliente.password` es NOT NULL. Aun asi se hashea, pero con 10 rondas y fuera
 * del camino critico: bcryptjs usa las funciones asincronas de Node
 * (setImmediate), asi que el trabajo pesado va al thread pool. Con 12 rondas
 * serian ~235ms y cada huesped nuevo frenaria a los demos un cuarto de segundo.
 *
 * La diferencia contra 12 rondas es irrelevante para un hash que nadie va a
 * adivinar: no hay login que lo compare, no hay fuerza bruta contra el.
 */
async function hashearCredencialMorta(clienteId) {
  try {
    const tempPassword = crypto.randomBytes(24).toString("hex");
    const hash = await bcrypt.hash(tempPassword, 10);
    await clienteService.guardarPasswordHasheado(clienteId, hash);
  } catch (err) {
    console.warn(
      `[Reserva] No se pudo hashear la credencial del cliente ${clienteId}:`,
      err.message
    );
  }
}

/**
 * Resuelve (o crea) el Cliente de un huesped.
 *
 * Si el email ya existe se reutiliza esa fila, que es lo que permite al huesped
 * que vuelve a reservar no perder su historial.
 */
async function obtenerOCrearCliente({ nombre, apellido, telefono, email }) {
  const existente = await clienteService.buscarPorEmail(email);

  if (existente) return existente;

  const creado = await executeQuery(
    `INSERT INTO Cliente (nombre, apellido, telefono, email, password)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nombre, apellido`,
    [nombre, apellido || "", telefono, email, "PENDIENTE"],
    ROL.ADMIN
  );

  // Fire-and-forget: si el hasheo falla o el proceso muere antes, la fila queda
  // con un marcador que no es un hash valido. Inofensivo justamente porque esa
  // contrasena nunca se usa para autenticarse.
  hashearCredencialMorta(creado.rows[0].id).catch(() => {});

  return creado.rows[0];
}

/** Valida que la habitacion exista, este activa y tenga lugar. */
async function validarHabitacion(habitacion_id, huespedes, fecha_entrada, fecha_salida) {
  const habCheck = await executeQuery(
    "SELECT id, numero, nombre, precio_noche, capacidad_max FROM Habitacion WHERE id = $1 AND activa = true",
    [habitacion_id],
    ROL.PUBLICO
  );

  if (habCheck.rows.length === 0) {
    throw new AppError("Habitacion no encontrada o no disponible", 404);
  }

  const habitacion = habCheck.rows[0];

  if (huespedes > habitacion.capacidad_max) {
    throw new AppError(
      `La habitacion tiene capacidad maxima de ${habitacion.capacidad_max} huespedes`,
      400
    );
  }

  const disponible = await executeQuery(
    "SELECT habitacion_disponible($1, $2, $3)",
    [habitacion_id, fecha_entrada, fecha_salida],
    ROL.PUBLICO
  );

  if (!disponible.rows[0].habitacion_disponible) {
    throw new AppError("La habitacion no esta disponible en las fechas seleccionadas", 409);
  }

  return habitacion;
}

/**
 * El email del admin no se puede reusar como Cliente.
 *
 * Si un huesped reserva con el, la reserva queda atada al cliente_id del admin: el
 * panel muestra como suya una reserva que no es, los avisos de WhatsApp salen al
 * telefono del admin en vez del huesped, y la bitacora queda con datos de alguien
 * que no reservo. Ademas, si todavia no existe un admin, un huesped podria
 * "reservar" con ese email y crearse el Cliente antes de que el administrador
 * llegue a registrarse, dejando trancado el registro.
 *
 * El control va ANTES de buscar y antes de insertar: si quedara despues del
 * SELECT, el caso recien instalado seguiria abierto.
 */
function rechazarEmailDelAdmin(email) {
  const adminEmail = config.auth.adminEmail;
  if (adminEmail && String(email).trim().toLowerCase() === adminEmail) {
    throw new AppError(
      `Ese email no puede usarse para reservar. Contactanos al ${TELEFONO_HOTEL}`,
      400
    );
  }
}

function validarFechas(fecha_entrada, fecha_salida) {
  const hoy = new Date().toISOString().slice(0, 10);

  if (fecha_entrada < hoy) {
    throw new AppError("La fecha de entrada no puede ser anterior a hoy", 400);
  }
  if (fecha_salida <= fecha_entrada) {
    throw new AppError("La fecha de salida debe ser posterior a la de entrada", 400);
  }
}

/**
 * Crea una reserva desde el sitio publico.
 *
 * El INSERT y el historial van en la misma transaccion. El 23P01 que puede tirar
 * el INSERT es la constraint de solapamiento rechazando una carrera: entre el
 * SELECT de disponibilidad y el INSERT otra reserva se adelante. Se traduce a
 * un 409 con el mensaje que el huesped ya conoce, en vez de un 500 de servidor.
 */
async function crear(datos, ip) {
  const {
    nombre,
    apellido,
    telefono,
    email,
    habitacion_id,
    fecha_entrada,
    fecha_salida,
    huespedes,
    notas,
  } = datos;

  validarFechas(fecha_entrada, fecha_salida);
  rechazarEmailDelAdmin(email);

  const habitacion = await validarHabitacion(habitacion_id, huespedes, fecha_entrada, fecha_salida);
  const cliente = await obtenerOCrearCliente({ nombre, apellido, telefono, email });

  const noches = nochesEntre(fecha_entrada, fecha_salida);
  const precio_total = noches * parseFloat(habitacion.precio_noche);
  const codigo = generateCode();

  let reserva;
  try {
    reserva = await withTransaction(async (client) => {
      const creada = await client.query(
        `INSERT INTO Reserva (codigo, cliente_id, habitacion_id, fecha_entrada, fecha_salida, huespedes, precio_total, notas, estado)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pendiente')
           RETURNING *`,
        [
          codigo,
          cliente.id,
          habitacion_id,
          fecha_entrada,
          fecha_salida,
          huespedes,
          precio_total,
          notas || null,
        ]
      );

      await client.query(
        `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
           VALUES ($1, 'Creada', $2, 'cliente', $3)`,
        [creada.rows[0].id, `Reserva creada por ${cliente.nombre} ${cliente.apellido || ""}`, ip]
      );

      return creada.rows[0];
    }, ROL.ADMIN);
  } catch (err) {
    // 23P01 = exclusion_violation.
    if (err && err.code === "23P01") {
      throw new AppError("La habitacion no esta disponible en las fechas seleccionadas", 409);
    }
    throw err;
  }

  emitNuevaReserva(reserva);
  notifyNewReserva(reserva, { nombre, apellido, email, telefono }, habitacion);

  return reserva;
}

// ---------------------------------------------------------------------------
// Cancelar (huesped)
// ---------------------------------------------------------------------------

/**
 * Cancelacion solicitada por el huesped, sin cuenta.
 *
 * Una sola transaccion con `FOR UPDATE OF r`: el lock se mantiene hasta el
 * UPDATE, asi que dos intentos simultaneos no pueden cancelar dos veces la misma
 * reserva.
 */
async function cancelarPorHuesped({ codigo, email, motivo }, ip) {
  const resultado = await withTransaction(async (client) => {
    const encontrada = await client.query(`${CONSULTA_POR_CODIGO} FOR UPDATE OF r`, [
      codigo,
      email,
    ]);

    if (encontrada.rows.length === 0) {
      throw new AppError("No encontramos una reserva con ese codigo y email", 404);
    }

    const reserva = encontrada.rows[0];

    if (!["Pendiente", "Confirmada"].includes(reserva.estado)) {
      throw new AppError(`La reserva ya esta ${reserva.estado.toLowerCase()}`, 400);
    }

    if (horasHastaEntrada(reserva.fecha_entrada) <= HORAS_CANCELACION) {
      throw new AppError(
        `Para cancelaciones con menos de ${HORAS_CANCELACION} horas de anticipacion, contactanos al ${TELEFONO_HOTEL}`,
        400
      );
    }

    const updated = await client.query(
      "UPDATE Reserva SET estado = 'Cancelada', updated_at = NOW() WHERE id = $1 RETURNING *",
      [reserva.id]
    );

    await client.query(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'Cancelada', $2, 'cliente', $3)`,
      [reserva.id, motivo || "Cancelacion solicitada por el huesped", ip]
    );

    return updated.rows[0];
  }, ROL.ADMIN);

  emitReservaActualizada(resultado);

  // El hotel tiene que enterarse: la habitacion vuelve a quedar libre para esas
  // fechas y puede ofrecerla a otro huesped.
  const datos = await obtenerContacto(resultado.id);
  if (datos) {
    notifyCancelacionHuesped(resultado, datos.cliente, datos.habitacion, motivo);
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Reporte de pago (huesped)
// ---------------------------------------------------------------------------

/**
 * El huesped aviso que ya transfirio al alias.
 *
 * NO cambia el estado de la reserva ni registra un pago: sigue en `Pendiente`.
 * Motivo: el hotel no tiene pasarela ni webhook, el dinero entra a una cuenta
 * que no consulta la app. El unico que puede afirmar que la plata llego es el
 * admin mirando el banco, asi que confirmar lo hace el admin desde el panel.
 *
 * Lo que si hace es dejar el aviso en el historial, que es lo que le permite al
 * admin ver "este huesped dice que ya pago" y buscar la transferencia en vez de
 * tener que asumir que todas las reservas pendientes estan impagas.
 *
 * El huesped se identifica con codigo + email, igual que consultar y cancelar.
 */
async function reportarPagoPorHuesped({ codigo, email }, ip) {
  const resultado = await withTransaction(async (client) => {
    const encontrada = await client.query(`${CONSULTA_POR_CODIGO} FOR UPDATE OF r`, [codigo, email]);

    if (encontrada.rows.length === 0) {
      throw new AppError("No encontramos una reserva con ese codigo y email", 404);
    }

    const reserva = encontrada.rows[0];

    // Si ya esta confirmada o cancelada el aviso no dice nada nuevo, y si esta
    // cancelada seria ruido: el huesped tendria que reservar de nuevo.
    if (!["Pendiente"].includes(reserva.estado)) {
      throw new AppError(`La reserva ya esta ${reserva.estado.toLowerCase()}`, 400);
    }

    await client.query(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'PagoReportado', $2, 'cliente', $3)`,
      [
        reserva.id,
        "El huesped informo que realizo la transferencia. La reserva sigue pendiente hasta que el hotel confirme el pago.",
        ip,
      ]
    );

    // updated_at sola vez: el estado no cambia, pero el hotel tiene que ver que
    // la reserva se movio al entrar en "revisar pagos".
    await client.query("UPDATE Reserva SET updated_at = NOW() WHERE id = $1", [reserva.id]);

    return reserva;
  }, ROL.ADMIN);

  emitReservaActualizada(resultado);

  const datos = await obtenerContacto(resultado.id);
  if (datos) {
    notifyPagoReportado(resultado, datos.cliente, datos.habitacion);
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function obtenerPorId(id) {
  const result = await executeQuery(
    `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo as tipo,
            c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email, c.telefono as cliente_telefono
     FROM Reserva r
     JOIN Habitacion h ON r.habitacion_id = h.id
     JOIN Cliente c ON r.cliente_id = c.id
     WHERE r.id = $1`,
    [id],
    ROL.ADMIN
  );

  if (result.rows.length === 0) throw new AppError("Reserva no encontrada", 404);
  return result.rows[0];
}

/**
 * Listado paginado con filtros, mas lo pagado de cada reserva.
 *
 * El saldo se calcula en el mismo SELECT con un LEFT JOIN sobre la suma de pagos
 * confirmados, para que el panel no tenga que pedir los pagos de cada fila.
 */
async function listar({ estado, desde, hasta, pagina = 1, limite = 20 }) {
  const paginaNum = Math.max(1, parseInt(pagina, 10) || 1);
  const limiteNum = Math.min(100, Math.max(1, parseInt(limite, 10) || 20));
  const offset = (paginaNum - 1) * limiteNum;

  let query = `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo as tipo,
                      c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email, c.telefono as cliente_telefono,
                      COALESCE(p.pagado, 0)::float as pagado,
                      (r.precio_total - COALESCE(p.pagado, 0))::float as saldo
               FROM Reserva r
               JOIN Habitacion h ON r.habitacion_id = h.id
               JOIN Cliente c ON r.cliente_id = c.id
               LEFT JOIN (
                   SELECT reserva_id, SUM(monto) AS pagado
                   FROM Pago
                   WHERE estado = 'Confirmado'
                   GROUP BY reserva_id
               ) p ON p.reserva_id = r.id
               WHERE 1=1`;
  const params = [];
  let i = 1;

  if (estado) {
    query += ` AND r.estado = $${i++}`;
    params.push(estado);
  }
  if (desde) {
    query += ` AND r.fecha_entrada >= $${i++}`;
    params.push(desde);
  }
  if (hasta) {
    query += ` AND r.fecha_salida <= $${i++}`;
    params.push(hasta);
  }

  const total = await executeQuery(`SELECT COUNT(*)::int FROM (${query}) sub`, params, ROL.ADMIN);

  query += " ORDER BY r.fecha_entrada DESC";
  query += ` LIMIT $${i} OFFSET $${i + 1}`;
  params.push(limiteNum, offset);

  const result = await executeQuery(query, params, ROL.ADMIN);

  return {
    reservas: result.rows,
    total: total.rows[0].count,
    pagina: paginaNum,
    total_paginas: Math.max(1, Math.ceil(total.rows[0].count / limiteNum)),
  };
}

/**
 * Cambia el estado de una reserva desde el panel.
 *
 * Se lee el estado anterior antes de actualizar: hace falta para no reavisar al
 * huesped si el admin guardo el mismo estado dos veces, y para tener los datos de
 * contacto del aviso.
 */
async function cambiarEstado(id, { estado, notas }, ip) {
  const validos = ["Pendiente", "Confirmada", "Cancelada", "Completada"];
  if (!validos.includes(estado)) {
    throw new AppError(`Estado invalido. Valores: ${validos.join(", ")}`, 400);
  }

  const anterior = await executeQuery(
    `SELECT r.estado,
            c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.telefono as cliente_telefono,
            h.numero as habitacion_numero, h.nombre as habitacion_nombre
     FROM Reserva r
     JOIN Cliente c ON c.id = r.cliente_id
     JOIN Habitacion h ON h.id = r.habitacion_id
     WHERE r.id = $1`,
    [id],
    ROL.ADMIN
  );

  if (anterior.rows.length === 0) throw new AppError("Reserva no encontrada", 404);
  const previa = anterior.rows[0];

  const result = await executeQuery(
    "UPDATE Reserva SET estado = $1 WHERE id = $2 RETURNING *",
    [estado, id],
    ROL.ADMIN
  );

  await executeQuery(
    `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
     VALUES ($1, $2, $3, 'admin', $4)`,
    [id, `Estado cambiado a ${estado}`, notas || null, ip],
    ROL.ADMIN
  );

  emitReservaActualizada(result.rows[0]);

  // El huesped solo necesita aviso de los estados que le cambian algo. Se dispara
  // sin await a proposito: el panel del admin no debe esperar a WhatsApp para
  // responder, y sendTextMessage ya captura sus propios errores.
  if (estado !== previa.estado) {
    const cliente = {
      nombre: previa.cliente_nombre,
      apellido: previa.cliente_apellido,
      telefono: previa.cliente_telefono,
    };
    const habitacion = {
      numero: previa.habitacion_numero,
      nombre: previa.habitacion_nombre,
    };

    if (estado === "Confirmada") {
      notifyReservaConfirmada(result.rows[0], cliente, habitacion);
    } else if (estado === "Cancelada") {
      notifyReservaCanceladaPorHotel(result.rows[0], cliente, habitacion);
    }
  }

  return result.rows[0];
}

module.exports = {
  consultarPorCodigo,
  cancelarPorHuesped,
  reportarPagoPorHuesped,
  crear,
  obtenerPorId,
  listar,
  cambiarEstado,
  obtenerContacto,
  puedeCancelar,
  horasHastaEntrada,
  fechaISO,
  nochesEntre,
  HORAS_CANCELACION,
};
