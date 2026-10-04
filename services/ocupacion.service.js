/**
 * Ocupacion: mapa de habitacion por dia, para pintar el calendario del panel.
 *
 * Devuelve una fila por habitacion, y adentro una lista de reservas con las
 * fechas ya expandidas a dias. Se opta por el rango completo y no por "consultar
 * cada dia" porque el calendario siempre pregunta entre 1 y 3 meses: con este
 * endpoint son dos consultas fijas sin importar el tamaño del rango, y con N
 * consultas habria que armar N llamadas para pintar la grilla.
 *
 * Solo trae reservas que ocupan la habitacion: Pendiente y Confirmada. Las
 * Canceladas y Completadas no bloquean, asi que no van.
 */

const { executeQuery, ROL } = require("../db");
const { AppError } = require("../utils/AppError");

// Techo de rango: sin esto un "hasta" a 5 anos trae cada reserva del hotel y se
// cuelga el panel. Un año alcanza de sobra para operar.
const MAX_DIAS = 400;

// pg devuelve las columnas DATE como Date en la zona horaria local, no como
// texto. Y comparar un Date contra un string en JavaScript NO convierte el string
// a fecha: convierte el Date a texto con su toString(), que empieza por el nombre
// del dia ("Thu Nov 05 2026..."). Como las letras ordenan despues que los digitos,
// "Thu..." > "2026-11-01" da true SIEMPRE, y el recorte de rango jamas se
// aplicaba: la cuenta daba 58 noches ocupadas en vez de 5.
//
// Aplanar todo a 'YYYY-MM-DD' y comparar texto ISO deja el recorte funcionando,
// porque en ISO el orden lexicografico coincide con el cronologico.
function fechaISO(valor) {
  if (valor instanceof Date) {
    const y = valor.getFullYear();
    const m = String(valor.getMonth() + 1).padStart(2, "0");
    const d = String(valor.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(valor).slice(0, 10);
}

async function obtener(desde, hasta) {
  if (!desde || !hasta) {
    throw new AppError("Se requiere desde y hasta (YYYY-MM-DD)", 400);
  }
  if (desde > hasta) {
    throw new AppError("desde no puede ser posterior a hasta", 400);
  }

  const dias = Math.round((new Date(hasta) - new Date(desde)) / 86400000);
  if (!Number.isFinite(dias) || dias < 0 || dias > MAX_DIAS) {
    throw new AppError(`El rango no puede superar los ${MAX_DIAS} dias`, 400);
  }

  const [habitaciones, reservas] = await Promise.all([
    executeQuery(
      `SELECT id, numero, nombre, tipo, precio_noche::float, capacidad_max
       FROM Habitacion
       WHERE activa = true
       ORDER BY numero`,
      [],
      ROL.ADMIN
    ),

    executeQuery(
      `SELECT r.id, r.codigo, r.habitacion_id, r.fecha_entrada, r.fecha_salida,
              r.estado, r.precio_total::float, r.huespedes,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido,
              c.telefono as cliente_telefono,
              COALESCE(p.pagado, 0)::float as pagado
       FROM Reserva r
       JOIN Cliente c ON c.id = r.cliente_id
       LEFT JOIN (
           SELECT reserva_id, SUM(monto) AS pagado
           FROM Pago WHERE estado = 'Confirmado' GROUP BY reserva_id
       ) p ON p.reserva_id = r.id
       WHERE reserva_ocupa_habitacion(r.estado)
         AND r.fecha_salida > $1
         AND r.fecha_entrada < $2
       ORDER BY r.fecha_entrada`,
      [desde, hasta],
      ROL.ADMIN
    ),
  ]);

  // Agrupar por habitacion para que el front no tenga que indexar cada vez.
  const porHabitacion = new Map();
  for (const fila of reservas.rows) {
    if (!porHabitacion.has(fila.habitacion_id)) porHabitacion.set(fila.habitacion_id, []);
    porHabitacion.get(fila.habitacion_id).push({
      id: fila.id,
      codigo: fila.codigo,
      fecha_entrada: fechaISO(fila.fecha_entrada),
      fecha_salida: fechaISO(fila.fecha_salida),
      estado: fila.estado,
      huespedes: fila.huespedes,
      precio_total: fila.precio_total,
      pagado: Number(fila.pagado),
      saldo: Number((fila.precio_total - Number(fila.pagado)).toFixed(2)),
      cliente: `${fila.cliente_nombre} ${fila.cliente_apellido || ""}`.trim(),
      telefono: fila.cliente_telefono,
    });
  }

  const resultado = habitaciones.rows.map((h) => ({
    ...h,
    reservas: porHabitacion.get(h.id) || [],
  }));

  // Noches ocupadas en el rango: es el numero que dice cuanto se rented la
  // habitacion, y de ahi sale la ocupacion porcentual.
  let nochesOcupadas = 0;
  let nochesPosibles = 0;

  for (const h of resultado) {
    nochesPosibles += dias;
    for (const r of h.reservas) {
      // Recorte contra los bordes del rango. Con fechas ya en ISO el comparador
      // de strings hace lo correcto.
      const inicio = r.fecha_entrada > desde ? r.fecha_entrada : desde;
      const fin = r.fecha_salida < hasta ? r.fecha_salida : hasta;
      nochesOcupadas += Math.max(0, Math.round((new Date(fin) - new Date(inicio)) / 86400000));
    }
  }

  return {
    desde,
    hasta,
    dias,
    habitaciones: resultado,
    resumen: {
      noches_ocupadas: nochesOcupadas,
      noches_posibles: nochesPosibles,
      ocupacion_pct:
        nochesPosibles > 0 ? Number(((nochesOcupadas / nochesPosibles) * 100).toFixed(1)) : 0,
      reservas_en_rango: reservas.rows.length,
    },
  };
}

module.exports = { obtener };
