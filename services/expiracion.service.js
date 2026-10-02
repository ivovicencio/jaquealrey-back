/**
 * Liberacion automatica de reservas sin pagar.
 *
 * POR QUE EXISTE
 *
 * El huesped crea la reserva y recien despues ve el alias. Entre una cosa y la
 * otra hay un tiempo en el que puede abandonar el flujo: se distrae, se da
 * cuenta de que no puede pagar, cambia de idea. La reserva queda `Pendiente`
 * para siempre y, como `Pendiente` bloquea la habitacion (la constraint de
 * solapamiento la cuenta como ocupada), eso es una habitacion que el hotel no
 * puede vender. En temporada de verano, con pocas habitaciones, cada una de
 * esas es una venta perdida.
 *
 * QUE HACE
 *
 * Cancela las reservas `Pendiente` que llevan mas de N horas sin que el huesped
 * avise que transfirio. No toca las `Confirmada` ni las que ya tienen el aviso de
 * pago: si el huesped dijo "ya transfirio", la decision es del admin que ve la
 * plata, no de este job.
 *
 * POR QUE ES UN JOB Y NO UNA CONSULTA EN EL MOMENTO DE RESERVAR
 *
 * Una consulta "libera lo viejo" al intentar reservar tiene dos problemas: no
 * corre si nadie reserva (que es justo cuando hay que limpiar), y en temporada
 * la consulta se vuelve mas cara cuantos mas pendientes se acumulan. Un job
 * con indice encima corre cada N minutos y no cuesta nada cuando no hay nada
 * que hacer.
 *
 * POR QUE UN INTERVALO Y NO UN CRON REAL
 *
 * El hotel tiene una sola instancia. Con `setInterval` no hace falta ni tabla de
 * comandos, ni multiples procesos peleandose por el mismo trabajo. Si alguna vez
 * corre mas de una instancia, el `SKIP LOCKED` de `expirarPendientes` hace que
 * cada una tome un subconjunto distinto y no se pisen entre si.
 */

const { executeQuery, ROL } = require("../db");
const { emitReservaActualizada } = require("../socket/socket");
const {
  notifyReservaExpirada,
  notifyPagoReportadoPendiente,
} = require("../helpers/whatsappHelper");
const config = require("../config");
const reservaService = require("./reserva.service");

const HORAS_EXPIRACION = config.reglas.horasExpiracionSinPago;
const INTERVALO_MS = config.reglas.intervaloExpiracionMs;

// Cada cuanto se repite el recordatorio de "verifica esta plata" mientras la
// reserva siga Pendiente. Sin esto el job mandaba el mismo WhatsApp cada 15 min
// (96 mensajes en 24 h) y el hotel terminaba silenciando al huesped real.
const INTERVALO_RECORDATORIO_HORAS = 6;

/**
 * Devuelve las reservas vencidas y las cancela en una transaccion.
 *
 * `FOR UPDATE SKIP LOCKED` es lo que hace seguro el `UPDATE` en bloque: si dos
 * instancias del job arrancan a la vez, cada una se lleva filas distintas en
 * vez de que la segunda espere y actualice lo que la primera ya cancelo (y le
 * escriba al historial dos veces el mismo aviso).
 *
 * El filtro de "el huesped aviso que transfirio" va en el mismo WHERE y no en
 * un IF de JavaScript a proposito: asi la fila nunca se marca como liberada, ni
 * aunque el job se corte a mitad de camino.
 */
async function expirarPendientes({ horas = HORAS_EXPIRACION } = {}) {
  // 0 (o menos) desactiva la liberacion, como dice .env.example. Sin esta guarda
  // el interval de abajo seria 0 horas, o sea "todo Pendiente que exista ahora
  // mismo", que es justo lo contrario de lo que se pidio al desactivarlo.
  if (!horas || horas <= 0) return [];

  const resultado = await executeQuery(
    `UPDATE Reserva r
     SET estado = 'Cancelada', updated_at = NOW()
     WHERE r.id IN (
       SELECT res.id
       FROM Reserva res
       WHERE res.estado = 'Pendiente'
         AND res.created_at < NOW() - ($1 || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM HistorialReserva h
           WHERE h.reserva_id = res.id AND h.accion = 'PagoReportado'
         )
       ORDER BY res.created_at ASC
       LIMIT 200
       FOR UPDATE OF res SKIP LOCKED
     )
     RETURNING r.*`,
    [String(horas)],
    ROL.ADMIN
  );

  const liberadas = resultado.rows;

  // El historial va aparte, y solo si se libero algo. Es un registro que el
  // hotel consulta para reconstruir que paso, asi que si la reserva quedo
  // cancelada tiene que decir por que.
  for (const reserva of liberadas) {
    await executeQuery(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'Liberada', $2, 'sistema', NULL)`,
      [
        reserva.id,
        `Sin pago: liberada automaticamente ${horas} h despues de crearse. La habitacion quedo disponible otra vez.`,
      ],
      ROL.ADMIN
    );

    emitReservaActualizada(reserva);

    const datos = await reservaService.obtenerContacto(reserva.id);
    if (datos) {
      await notifyReservaExpirada(reserva, datos.cliente, datos.habitacion, horas);
    }
  }

  if (liberadas.length > 0) {
    console.log(
      `[Expiracion] ${liberadas.length} reserva(s) liberada(s) por no tener pago (${horas} h)`
    );
  }

  return liberadas;
}

/**
 * Avisa al hotel de las reservas que el huesped dijo que transfirio y que hace
 * de que las esta mirando.
 *
 * Va aparte de `expirarPendientes` a proposito: estas reservas NO se liberan
 * (el huesped afirmo que pago, entonces la decision es del admin), pero si nadie
 * las mira se quedan colgadas. El hotel necesita enterarse de que hay plata
 * incoming, que es justamente el trabajo que hay que hacer todos los dias.
 *
 * POR QUE NO USA `JOIN` CON EL HISTORIAL
 *
 * Con `JOIN`, una reserva a la que el huesped aviso dos veces ("ya transferi" y
 * un rato despues otra vez) salia dos filas y el admin recibia dos WhatsApp en el
 * mismo ciclo. `EXISTS` es una pregunta de si/no, que es lo que realmente se
 * esta preguntando.
 *
 * POR QUE EL CORTECIRCUITO
 *
 * El job corre cada 15 min. Sin el corte, la misma reserva generates ~96 avisos
 * en 24 h. Cada aviso que se manda deja su rastro en el historial, asi que el
 * corte se consulta ahi en vez de llevar una tabla de "ya avisados" que se
 * desincroniza de la base.
 */
async function avisarPagosReportadosPendientes() {
  const resultado = await executeQuery(
    `SELECT r.*
     FROM Reserva r
     WHERE r.estado = 'Pendiente'
       AND EXISTS (
         SELECT 1 FROM HistorialReserva h
         WHERE h.reserva_id = r.id
           AND h.accion = 'PagoReportado'
           AND h.created_at > NOW() - ($1 || ' hours')::interval
       )
       AND NOT EXISTS (
         SELECT 1 FROM HistorialReserva h2
         WHERE h2.reserva_id = r.id AND h2.accion = 'Liberada'
       )
       AND NOT EXISTS (
         SELECT 1 FROM HistorialReserva h3
         WHERE h3.reserva_id = r.id
           AND h3.accion = 'RecordatorioPago'
           AND h3.created_at > NOW() - ($2 || ' hours')::interval
       )`,
    [String(24), String(INTERVALO_RECORDATORIO_HORAS)],
    ROL.ADMIN
  );

  let avisados = 0;

  for (const reserva of resultado.rows) {
    const datos = await reservaService.obtenerContacto(reserva.id);
    if (!datos) continue;

    await notifyPagoReportadoPendiente(reserva, datos.cliente, datos.habitacion);

    // Se marca DESPUES de avisar: si el envio falla, la proxima pasada reintenta
    // en vez de dar el recordatorio por hecho.
    await executeQuery(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'RecordatorioPago', $2, 'sistema', NULL)`,
      [reserva.id, `Recordatorio: verificar la transferencia de la reserva ${reserva.codigo}.`],
      ROL.ADMIN
    );

    avisados++;
  }

  if (avisados > 0) {
    console.log(
      `[Expiracion] ${avisados} reserva(s) con pago reportado pendiente(s) de verificar.`
    );
  }

  return resultado.rows;
}

// ---------------------------------------------------------------------------
// Arranque y parada del job
// ---------------------------------------------------------------------------

let timer = null;

/**
 * Prende el job. Idempotente: llamarlo dos veces no deja dos timers.
 *
 * `.unref()` para que el timer NO mantenga vivo el proceso. Sin esto, un script
 * que importa el server para probarlo (los tests) se queda colgado para siempre
 * esperando al proximo tick.
 */
function iniciarJobExpiracion() {
  if (timer) return timer;

  if (!HORAS_EXPIRACION || HORAS_EXPIRACION <= 0) {
    console.log(
      `[Expiracion] Desactivada (RESERVAS_EXPIRAR_HORAS=${HORAS_EXPIRACION}). Las reservas sin pago no se liberan solas.`
    );
    return null;
  }

  // Se corre una vez al arrancar, ademas del intervalo: si el proceso se reinicio
  // con reservas vencidas acumuladas, la primera pasada las libera de entrada.
  const correr = async () => {
    try {
      await expirarPendientes();
      await avisarPagosReportadosPendientes();
    } catch (err) {
      // Un job que revienta se lleva por delante el proceso si no se lo come.
      // Loguear y seguir: en el proximo tick vuelve a intentar.
      console.error("[Expiracion] Error en el ciclo:", err.message);
    }
  };

  timer = setInterval(correr, INTERVALO_MS);
  timer.unref();
  console.log(
    `[Expiracion] Activa: libera reservas sin pago cada ${Math.round(INTERVALO_MS / 60000)} min, venciendo a las ${HORAS_EXPIRACION} h.`
  );

  setTimeout(correr, 5000).unref();
  return timer;
}

function detenerJobExpiracion() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("[Expiracion] Detenido");
}

module.exports = {
  expirarPendientes,
  avisarPagosReportadosPendientes,
  iniciarJobExpiracion,
  detenerJobExpiracion,
  HORAS_EXPIRACION,
  INTERVALO_RECORDATORIO_HORAS,
};
