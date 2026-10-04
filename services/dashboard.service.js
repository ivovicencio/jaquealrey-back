/**
 * Dashboard: las cifras que mira el hotel al abrir el panel.
 *
 * Varias consultas en paralelo porque no dependen entre si. El detalle mes a mes
 * no vive aca: esta en `pago.service.ingresos()` (GET /api/pagos/ingresos).
 */

const { executeQuery, ROL } = require("../db");

async function obtener() {
  const [reservasActivas, reservasProximas, ingresos, totalClientes, totalHabitaciones] =
    await Promise.all([
      // reserva_ocupa_habitacion() y no la lista literal: este es el conteo de
      // "reservas que están comprometiendo una habitación", así que tiene que
      // contar exactamente las mismas que cuentan las funciones de
      // disponibilidad. Con la lista escrita a mano, el día que se agregue un
      // estado el dashboard muestra un número y la disponibilidad decide otro.
      executeQuery(
        "SELECT COUNT(*)::int FROM Reserva WHERE reserva_ocupa_habitacion(estado)",
        [],
        ROL.ADMIN
      ),

      executeQuery(
        `SELECT COUNT(*)::int FROM Reserva
       WHERE reserva_ocupa_habitacion(estado)
         AND fecha_entrada >= CURRENT_DATE
         AND fecha_entrada <= CURRENT_DATE + INTERVAL '7 days'`,
        [],
        ROL.ADMIN
      ),

      // Facturado y cobrado van separados a proposito. Antes este bloque sumaba
      // precio_total por created_at, que mezclaba dos cosas distintas: una reserva
      // creada en marzo para abril contaba como ingreso de marzo, y una reserva
      // confirmada que aun nadie pago contaba como plata recibida.
      //
      // 'En_Casa' entra en facturado: la habitacion ocupada hoy tiene una
      // reserva que se facturó y cuyo huesped ya esta adentro. Si queda afuera,
      // el hotel ve facturado en cero mientras tiene la habitacion llena.
      executeQuery(
        `SELECT
         (SELECT COALESCE(SUM(precio_total), 0)::float FROM Reserva
           WHERE estado IN ('Confirmada','En_Casa','Completada')
             AND date_trunc('month', fecha_salida) = date_trunc('month', CURRENT_DATE)) AS facturado_mes,
         (SELECT COALESCE(SUM(monto), 0)::float FROM Pago
           WHERE estado = 'Confirmado'
             AND date_trunc('month', fecha_pago) = date_trunc('month', CURRENT_DATE)) AS cobrado_mes`,
        [],
        ROL.ADMIN
      ),

      executeQuery("SELECT COUNT(*)::int FROM Cliente", [], ROL.ADMIN),
      executeQuery("SELECT COUNT(*)::int FROM Habitacion WHERE activa = true", [], ROL.ADMIN),
    ]);

  const ing = ingresos.rows[0];
  const facturadoMes = Number(ing.facturado_mes);
  const cobradoMes = Number(ing.cobrado_mes);

  return {
    reservas_activas: reservasActivas.rows[0].count,
    reservas_proximas_7_dias: reservasProximas.rows[0].count,
    facturado_mes_actual: facturadoMes,
    cobrado_mes_actual: cobradoMes,
    // Lo que se facturo en el mes y todavia no se cobro. Es el numero que dice
    // cuanto hay que perseguir.
    a_cobrar_mes: Number((facturadoMes - cobradoMes).toFixed(2)),
    total_clientes: totalClientes.rows[0].count,
    habitaciones_activas: totalHabitaciones.rows[0].count,
  };
}

module.exports = { obtener };
