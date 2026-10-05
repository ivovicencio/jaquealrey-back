/**
 * Pagos y estado de cuenta.
 *
 * El hotel cobra por alias o efectivo. Confirmacion 100% manual: una persona ve
 * que la plata entro y marca el pago. Nada se confirma solo.
 *
 * Dos reglas que atraviesan todo el archivo:
 *
 *  1. NO se acepta tarjeta. Los metodos validos son alias, efectivo y otro.
 *     Guardar datos de tarjeta en el sistema es un circuito legal (Ley de
 *     Operador Financiero) que un hotel de 10 habitaciones no justifica. Si
 *     alguna vez hace falta cobrar con tarjeta, la salida es un terminal fisico
 *     del banco.
 *
 *  2. El aviso al huesped sale SOLO cuando el pago queda Confirmado. Un pago
 *     Pendiente no manda nada: todavia no hay plata acreditada y el mensaje le
 *     diria que tiene la habitacion sin que el hotel haya cobrado.
 */

const { executeQuery, withTransaction, ROL } = require("../db");
const { AppError } = require("../utils/AppError");
const { notifyPagoConfirmado } = require("../helpers/whatsappHelper");

const METODOS = ["alias", "efectivo", "otro"];
const ESTADOS = ["Pendiente", "Confirmado", "Anulado"];

// Tolerancia al comparar montos, en CENTAVOS y no en pesos.
//
// El problema del 0.001 original no era la tolerancia sino la unidad: sobre
// montos de $100.000 el float64 tiene una precisión de ~1,5e-11, así que un
// epsilon de 0.001 es cinco órdenes de magnitud más grande que el error real.
// En la práctica el admin podía sobrepagar hasta el 0,1% del total y el
// sistema lo daba por bien pagado.
//
// 0.05 es medio centavo: dos órdenes de magnitud por debajo del error de
// redondeo de un peso, y a la vez suficientemente holgado para que un pago
// partido en varias partes no rebote por un redondeo de centavos.
const EPSILON = 0.05;

// ---------------------------------------------------------------------------
// Aviso al huesped
// ---------------------------------------------------------------------------

/**
 * Reune los datos y le manda el WhatsApp de pago confirmado.
 *
 * Va en su propia consulta y no dentro de la transaccion a proposito: el UPDATE
 * ya se confirmo cuando esto corre, asi que leer los datos afuera no puede volver
 * fallar la operacion que el admin ya ejecuto.
 */
async function avisarPagoConfirmado(pagoId) {
  const datos = await executeQuery(
    `SELECT p.id, p.monto::float, p.metodo,
            r.codigo, r.fecha_entrada, r.fecha_salida, r.huespedes,
            r.precio_total::float,
            h.numero AS hab_numero, h.nombre AS hab_nombre,
            c.nombre AS cli_nombre, c.apellido AS cli_apellido, c.telefono,
            (SELECT COALESCE(SUM(p2.monto), 0)::float
               FROM Pago p2
              WHERE p2.reserva_id = p.reserva_id AND p2.estado = 'Confirmado') AS pagado_total
     FROM Pago p
     JOIN Reserva r    ON r.id = p.reserva_id
     JOIN Habitacion h ON h.id = r.habitacion_id
     JOIN Cliente c    ON c.id = r.cliente_id
    WHERE p.id = $1`,
    [pagoId],
    ROL.ADMIN
  );

  if (datos.rows.length === 0) return;
  const d = datos.rows[0];

  await notifyPagoConfirmado(
    {
      codigo: d.codigo,
      fecha_entrada: d.fecha_entrada,
      fecha_salida: d.fecha_salida,
      huespedes: d.huespedes,
      precio_total: d.precio_total,
    },
    { nombre: d.cli_nombre, apellido: d.cli_apellido, telefono: d.telefono },
    { numero: d.hab_numero, nombre: d.hab_nombre },
    { monto: d.monto, metodo: d.metodo, saldo_pagado: d.pagado_total }
  );
}

/** Lanza el aviso sin esperar. El mensaje es una consecuencia, no la operacion. */
function avisarEnSegundoPlano(pagoId) {
  avisarPagoConfirmado(pagoId).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

/** Estado de cuenta de una reserva: cuanto se pago, cuanto falta. */
async function obtenerPorReserva(reservaId) {
  const pagos = await executeQuery(
    `SELECT id, monto::float, metodo, estado, referencia, fecha_pago, notas, created_at
     FROM Pago
     WHERE reserva_id = $1
     ORDER BY created_at DESC`,
    [reservaId],
    ROL.ADMIN
  );

  const reserva = await executeQuery(
    "SELECT precio_total::float FROM Reserva WHERE id = $1",
    [reservaId],
    ROL.ADMIN
  );

  if (reserva.rows.length === 0) throw new AppError("Reserva no encontrada", 404);

  const totalReserva = reserva.rows[0].precio_total;
  const pagado = pagos.rows
    .filter((p) => p.estado === "Confirmado")
    .reduce((acc, p) => acc + Number(p.monto), 0);

  return {
    pagos: pagos.rows,
    total_reserva: totalReserva,
    total_pagado: pagado,
    saldo: Number((totalReserva - pagado).toFixed(2)),
  };
}

/** Listado global de pagos, paginado y filtrable. */
async function listar({ reserva_id, estado, metodo, desde, hasta, pagina = 1, limite = 20 }) {
  const paginaNum = Math.max(1, parseInt(pagina, 10) || 1);
  const limiteNum = Math.min(100, Math.max(1, parseInt(limite, 10) || 20));
  const offset = (paginaNum - 1) * limiteNum;

  let query = `SELECT p.id, p.reserva_id, p.monto::float, p.metodo, p.estado, p.referencia,
                      p.fecha_pago, p.notas, p.created_at,
                      r.codigo as reserva_codigo, r.fecha_entrada, r.fecha_salida,
                      h.numero as habitacion_numero,
                      c.nombre as cliente_nombre, c.apellido as cliente_apellido
               FROM Pago p
               JOIN Reserva r ON r.id = p.reserva_id
               JOIN Habitacion h ON h.id = r.habitacion_id
               JOIN Cliente c ON c.id = r.cliente_id
               WHERE 1=1`;
  const params = [];
  let i = 1;

  if (reserva_id) {
    query += ` AND p.reserva_id = $${i++}`;
    params.push(parseInt(reserva_id, 10));
  }
  if (estado) {
    query += ` AND p.estado = $${i++}`;
    params.push(estado);
  }
  if (metodo) {
    query += ` AND p.metodo = $${i++}`;
    params.push(metodo);
  }
  if (desde) {
    query += ` AND p.fecha_pago >= $${i++}`;
    params.push(desde);
  }
  if (hasta) {
    query += ` AND p.fecha_pago <= $${i++}`;
    params.push(hasta);
  }

  const total = await executeQuery(`SELECT COUNT(*)::int FROM (${query}) sub`, params, ROL.ADMIN);

  // El `i` no se vuelve a leer despues, asi que no hace falta incrementarlo: los
  // dos placeholders se calculan desde el mismo valor.
  query += ` ORDER BY COALESCE(p.fecha_pago, p.created_at) DESC LIMIT $${i} OFFSET $${i + 1}`;
  params.push(limiteNum, offset);

  const result = await executeQuery(query, params, ROL.ADMIN);

  return {
    pagos: result.rows,
    total: total.rows[0].count,
    pagina: paginaNum,
    total_paginas: Math.max(1, Math.ceil(total.rows[0].count / limiteNum)),
  };
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

function validarAlta({ reserva_id, monto, metodo, estado }) {
  if (!reserva_id || !monto) {
    throw new AppError("Se requiere reserva_id y monto", 400);
  }

  const valorMonto = Number(monto);
  if (!Number.isFinite(valorMonto) || valorMonto <= 0) {
    throw new AppError("El monto debe ser un numero mayor a 0", 400);
  }

  const metodoFinal = metodo || "alias";
  if (!METODOS.includes(metodoFinal)) {
    throw new AppError(`Metodo invalido. Valores: ${METODOS.join(", ")}`, 400);
  }

  const estadoFinal = estado || "Pendiente";
  if (!ESTADOS.includes(estadoFinal)) {
    throw new AppError(`Estado invalido. Valores: ${ESTADOS.join(", ")}`, 400);
  }

  return { valorMonto, metodoFinal, estadoFinal };
}

/**
 * Registra un pago.
 *
 * El chequeo de sobrepago, el INSERT y el historial van juntos, con FOR UPDATE
 * sobre la reserva.
 *
 * Con las consultas sueltas habia una carrera: dos admins confirmando a la vez
 * leian el mismo totalPrevio, los dos pasaban el control de sobrepago y los dos
 * INSERTs confirmaban. El saldo quedaba en negativo y el reporte de ingresos
 * mostraba un credito fantasma. El lock de fila serializa a los dos: el segundo
 * espera al COMMIT del primero y recien ahi relee el total.
 */
async function crear(datos, ip) {
  const { reserva_id, referencia, fecha_pago, notas } = datos;
  const { valorMonto, metodoFinal, estadoFinal } = validarAlta(datos);

  let creado;
  try {
    creado = await withTransaction(async (client) => {
      // En_Casa tambien admite pagos: el saldo se cobra muchas veces en el
      // momento del check-out, que es cuando el huesped ya esta en la habitacion.
      const reserva = await client.query(
        `SELECT id, codigo, estado, precio_total::float
           FROM Reserva
          WHERE id = $1 AND estado IN ('Pendiente', 'Confirmada', 'En_Casa')
          FOR UPDATE`,
        [reserva_id]
      );

      if (reserva.rows.length === 0) {
        // No puede ser "no existe" y "no admite pagos" a la vez: se distingue
        // con una segunda consulta para no mandar un 404 donde va un 409.
        const estadoActual = await client.query(
          "SELECT estado FROM Reserva WHERE id = $1",
          [reserva_id]
        );
        if (estadoActual.rows.length === 0) {
          throw new AppError("Reserva no encontrada", 404);
        }
        throw new AppError(
          `La reserva no admite pagos: esta ${estadoActual.rows[0].estado}`,
          409
        );
      }

      const pagadoPrevio = await client.query(
        `SELECT COALESCE(SUM(monto), 0)::float AS total
           FROM Pago
          WHERE reserva_id = $1 AND estado = 'Confirmado'`,
        [reserva_id]
      );
      const totalPrevio = Number(pagadoPrevio.rows[0].total);
      const totalReserva = reserva.rows[0].precio_total;

      if (estadoFinal === "Confirmado" && totalPrevio + valorMonto > totalReserva + EPSILON) {
        throw new AppError(
          `El pago excede el total de la reserva. Total ${totalReserva}, ya pagado ${totalPrevio}`,
          400
        );
      }

      // La constraint de la base exige fecha si el pago queda confirmado. Se
      // completa con NOW() para que el admin no tenga que escribirla.
      const fechaFinal =
        fecha_pago || (estadoFinal === "Confirmado" ? new Date().toISOString() : null);

      const insertado = await client.query(
        `INSERT INTO Pago (reserva_id, monto, metodo, estado, referencia, fecha_pago, notas)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, reserva_id, monto::float, metodo, estado, referencia, fecha_pago, notas, created_at`,
        [
          reserva_id,
          valorMonto,
          metodoFinal,
          estadoFinal,
          referencia || null,
          fechaFinal,
          notas || null,
        ]
      );

      await client.query(
        `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [
          reserva_id,
          `Pago ${estadoFinal.toLowerCase()}: ${valorMonto}`,
          referencia ? `Referencia ${referencia}` : null,
          ip,
        ]
      );

      return insertado.rows[0];
    }, ROL.ADMIN);
  } catch (err) {
    // La base tiene un indice unico sobre la referencia de los pagos confirmados.
    // Si el admin carga dos veces el mismo comprobante, aca se corta.
    if (err.code === "23505") {
      throw new AppError("Ya existe un pago confirmado con esa referencia", 409);
    }
    throw err;
  }

  if (creado.estado === "Confirmado") avisarEnSegundoPlano(creado.id);
  return creado;
}

/**
 * Cambia el estado de un pago (tipicamente Pendiente -> Confirmado).
 *
 * El UPDATE y el historial van en la misma transaccion, con FOR UPDATE sobre el
 * pago y sobre la reserva.
 *
 * Esto tambien cierra una carrera entre admins: dos confirmaciones
 * simultaneas del mismo pago pasaban las dos el chequeo de "ya estaba confirmado"
 * y las dos escribian historial, o dos pagos pendientes distintos se confirmaban
 * a la vez y los dos pasaban el control de sobrepago leyendo el mismo total. Con
 * el lock, el segundo espera al COMMIT del primero y relee el estado real.
 */
async function cambiarEstado(id, { estado, referencia, fecha_pago, notas }, ip) {
  if (!ESTADOS.includes(estado)) {
    throw new AppError(`Estado invalido. Valores: ${ESTADOS.join(", ")}`, 400);
  }

  let pago;
  try {
    pago = await withTransaction(async (client) => {
      const previo = await client.query(
        "SELECT id, reserva_id, monto::float, estado FROM Pago WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (previo.rows.length === 0) throw new AppError("Pago no encontrado", 404);

      const anterior = previo.rows[0];

      if (estado === "Confirmado" && anterior.estado === "Confirmado") {
        throw new AppError("El pago ya estaba confirmado", 400);
      }

      if (estado === "Confirmado") {
        // El lock va sobre la reserva y no solo sobre el pago: el sobrepago se
        // decide contra el total de la reserva, asi que el lock tiene que
        // serializar a todos los pagos de esa reserva, no a uno solo.
        //
        // El lock se toma en una consulta aparte, sin GROUP BY: Postgres rechaza
        // FOR UPDATE cuando la consulta trae agregacion ("FOR UPDATE is not
        // allowed with GROUP BY clause"), y la suma de lo ya confirmado necesita
        // agrupar. Se bloquea la fila primero y recien despues se suma, que es
        // el orden correcto igual: el lock ya esta tomado cuando se lee la suma.
        await client.query("SELECT id FROM Reserva WHERE id = $1 FOR UPDATE", [
          anterior.reserva_id,
        ]);

        const sumaPrevia = await client.query(
          `SELECT r.precio_total::float AS total,
                  COALESCE(SUM(p.monto) FILTER (WHERE p.estado = 'Confirmado' AND p.id <> $1), 0)::float AS pagado
             FROM Reserva r
             LEFT JOIN Pago p ON p.reserva_id = r.id
            WHERE r.id = $2
            GROUP BY r.id`,
          [id, anterior.reserva_id]
        );

        const fila = sumaPrevia.rows[0];
        if (fila && Number(fila.pagado) + Number(anterior.monto) > Number(fila.total) + EPSILON) {
          throw new AppError(
            `El pago excede el total de la reserva. Total ${fila.total}, ya pagado ${fila.pagado}`,
            400
          );
        }
      }

      const fechaEnTransaccion =
        estado === "Confirmado" ? fecha_pago || new Date().toISOString() : fecha_pago || null;

      const result = await client.query(
        `UPDATE Pago
            SET estado = $1,
                referencia = COALESCE($2, referencia),
                fecha_pago = $3,
                notas = COALESCE($4, notas),
                updated_at = NOW()
          WHERE id = $5
          RETURNING id, reserva_id, monto::float, metodo, estado, referencia, fecha_pago, notas`,
        [estado, referencia || null, fechaEnTransaccion, notas || null, id]
      );

      await client.query(
        `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [anterior.reserva_id, `Pago ${anterior.estado} -> ${estado}`, `Monto ${anterior.monto}`, ip]
      );

      return result.rows[0];
    }, ROL.ADMIN);
  } catch (err) {
    if (err.code === "23505") {
      throw new AppError("Ya existe un pago confirmado con esa referencia", 409);
    }
    throw err;
  }

  if (pago.estado === "Confirmado") avisarEnSegundoPlano(pago.id);
  return pago;
}

// ---------------------------------------------------------------------------
// Ingresos
// ---------------------------------------------------------------------------

/**
 * Resumen de ingresos.
 *
 * Aca esta la diferencia importante entre facturado y cobrado, que el hotel la
 * necesita separada:
 *
 *   facturado = SUM(precio_total) de las reservas confirmadas, agrupado por mes
 *               de estadia (la fecha en que termina la reserva)
 *   cobrado   = SUM(monto) de los pagos confirmados, agrupado por mes en que se
 *               cobraron (fecha_pago)
 *
 * Los totales se muestran por separado porque corresponden a fechas distintas:
 * estadía para lo facturado y fecha de recepción para lo cobrado.
 *
 * Una version anterior del dashboard sumaba precio_total por created_at, o sea
 * cuando se creo el registro. Eso mezclaba las dos cosas y ademas corria los
 * meses: una reserva creada en marzo para abril contaba como ingreso de marzo.
 */
async function ingresos({ desde } = {}) {
  const filtro = desde ? "AND fecha_salida >= $1" : "";
  const params = desde ? [desde] : [];

  const [facturado, cobrado, totales, pagosIncompletos] = await Promise.all([
    // Facturado por mes de estadia.
    //
    // 'En_Casa' cuenta: la habitacion ocupada hoy tiene una reserva facturada y
    // cuyo huesped ya esta adentro. Dejarla afuera hace que el hotel vea
    // facturado en cero mientras tiene el hotel lleno.
    executeQuery(
      `SELECT to_char(date_trunc('month', fecha_salida), 'YYYY-MM') AS mes,
              COUNT(*)::int AS reservas,
              SUM(precio_total)::float AS total
       FROM Reserva
       WHERE estado IN ('Confirmada', 'En_Casa', 'Completada') ${filtro}
       GROUP BY 1
       ORDER BY 1 DESC`,
      params,
      ROL.ADMIN
    ),

    // Cobrado por mes en que se recibio el dinero.
    executeQuery(
      `SELECT to_char(date_trunc('month', fecha_pago), 'YYYY-MM') AS mes,
              COUNT(*)::int AS cantidad,
              SUM(monto)::float AS total
       FROM Pago
       WHERE estado = 'Confirmado' AND fecha_pago IS NOT NULL
       GROUP BY 1
       ORDER BY 1 DESC`,
      [],
      ROL.ADMIN
    ),

    executeQuery(
      `SELECT
         (SELECT COALESCE(SUM(precio_total), 0)::float FROM Reserva
           WHERE estado IN ('Confirmada','En_Casa','Completada')) AS facturado_total,
         -- Se excluyen pagos asociados a reservas canceladas.
         (SELECT COALESCE(SUM(p.monto), 0)::float
            FROM Pago p JOIN Reserva r ON r.id = p.reserva_id
           WHERE p.estado = 'Confirmado'
             AND r.estado IN ('Confirmada','En_Casa','Completada')) AS cobrado_total,
         (SELECT COALESCE(SUM(monto), 0)::float FROM Pago
           WHERE estado = 'Pendiente') AS pendiente_total`,
      [],
      ROL.ADMIN
    ),

    // Se expone el estado del pago, no una cuenta por cobrar.
    executeQuery(
      `SELECT r.id, r.codigo, r.precio_total::float, r.fecha_entrada, r.fecha_salida,
              COALESCE(SUM(p.monto) FILTER (WHERE p.estado = 'Confirmado'), 0)::float AS pagado
       FROM Reserva r
       LEFT JOIN Pago p ON p.reserva_id = r.id
       WHERE r.estado IN ('Confirmada', 'En_Casa', 'Completada')
       GROUP BY r.id
       HAVING COALESCE(SUM(p.monto) FILTER (WHERE p.estado = 'Confirmado'), 0) + ${EPSILON} < r.precio_total
       ORDER BY r.fecha_salida
       LIMIT 100`,
      [],
      ROL.ADMIN
    ),
  ]);

  const t = totales.rows[0];

  return {
    facturado_total: t.facturado_total,
    cobrado_total: t.cobrado_total,
    pendiente_confirmar: t.pendiente_total,
    por_mes_facturado: facturado.rows,
    por_mes_cobrado: cobrado.rows,
    pagos_incompletos: pagosIncompletos.rows.map((r) => ({
      ...r,
      pago_completo: Number(r.pagado) + EPSILON >= Number(r.precio_total),
    })),
  };
}

module.exports = { obtenerPorReserva, listar, crear, cambiarEstado, ingresos, METODOS, ESTADOS };
