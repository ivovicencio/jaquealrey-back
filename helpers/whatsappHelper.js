const axios = require("axios");
const config = require("../config");

const WHATSAPP_TOKEN = config.whatsapp.token;
const WHATSAPP_PHONE_ID = config.whatsapp.phoneId;
const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

const ADMIN_WHATSAPP = config.whatsapp.adminWhatsapp;
const HOTEL_PHONE = config.whatsapp.hotelPhone;

function formatPhoneNumber(phone) {
  const cleaned = String(phone || "").replace(/\D/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("54")) return cleaned;
  if (cleaned.startsWith("0")) return `54${cleaned.slice(1)}`;
  return `54${cleaned}`;
}

async function sendTextMessage(to, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("[WhatsApp] No configurado, ignorando mensaje");
    return;
  }

  const destino = formatPhoneNumber(to);
  if (!destino) {
    console.warn("[WhatsApp] Numero invalido o vacio, ignorando mensaje");
    return;
  }

  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: "whatsapp",
        to: destino,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("[WhatsApp] Mensaje enviado a", destino);
  } catch (err) {
    console.error("[WhatsApp] Error al enviar mensaje:", err.response?.data || err.message);
  }
}

async function notifyNewReserva(reserva, cliente, habitacion) {
  const fechaEntrada = new Date(reserva.fecha_entrada).toLocaleDateString("es-AR");
  const fechaSalida = new Date(reserva.fecha_salida).toLocaleDateString("es-AR");

  const mensaje = `🏨 *Nueva Reserva - Jaque al Rey*
Código: ${reserva.codigo}
Cliente: ${cliente.nombre} ${cliente.apellido || ""}
Email: ${cliente.email}
Teléfono: ${cliente.telefono}
Habitación: ${habitacion.nombre} (#${habitacion.numero})
Entrada: ${fechaEntrada}
Salida: ${fechaSalida}
Huéspedes: ${reserva.huespedes}
Total: $${Number(reserva.precio_total).toLocaleString("es-AR")}
Estado: ${reserva.estado}`;

  if (ADMIN_WHATSAPP) {
    await sendTextMessage(ADMIN_WHATSAPP, mensaje);
  }
}

function datosReserva(reserva, habitacion) {
  const entrada = new Date(reserva.fecha_entrada).toLocaleDateString("es-AR");
  const salida = new Date(reserva.fecha_salida).toLocaleDateString("es-AR");
  return [
    `Codigo: ${reserva.codigo}`,
    habitacion ? `Habitacion: #${habitacion.numero} ${habitacion.nombre || ""}`.trim() : null,
    `Entrada: ${entrada}`,
    `Salida: ${salida}`,
    `Huespedes: ${reserva.huespedes}`,
    `Total: $${Number(reserva.precio_total).toLocaleString("es-AR")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// El huesped no tiene cuenta, asi que el canal de aviso es el telefono que
// dejo al reservar. Si no hay telefono no hay nada mas que hacer.
async function notificarHuesped(reserva, cliente, habitacion, mensaje) {
  if (!cliente || !cliente.telefono) {
    console.warn(`[WhatsApp] Reserva ${reserva.codigo} sin telefono, no se avisa al huesped`);
    return;
  }
  await sendTextMessage(cliente.telefono, mensaje);
}

async function notifyReservaConfirmada(reserva, cliente, habitacion) {
  const mensaje = `🏨 *Reserva confirmada - Jaque al Rey*
${datosReserva(reserva, habitacion)}

Tu reserva quedo confirmada. El ingreso es a partir de las 14:00 hs y la salida antes de las 10:00 hs.
Cualquier consulta al ${HOTEL_PHONE}.`;

  await notificarHuesped(reserva, cliente, habitacion, mensaje);
}

async function notifyReservaCanceladaPorHotel(reserva, cliente, habitacion) {
  const mensaje = `⚠️ *Reserva cancelada por el hotel - Jaque al Rey*
${datosReserva(reserva, habitacion)}

Tu reserva fue cancelada por el hotel. No tenes que pagar nada.
Escribinos al ${HOTEL_PHONE} para que te ofrezcamos una alternativa o el reembolso de lo abonado.`;

  await notificarHuesped(reserva, cliente, habitacion, mensaje);
}

// Aviso de no presentación.
//
// No reutiliza notifyReservaCanceladaPorHotel a propósito. Ese mensaje dice
// "tu reserva fue cancelada por el hotel, no tenés que pagar nada", y acá el
// hotel no canceló nada: el huésped no arrived. Mandarle eso sería
// Informarle una cosa que no pasó, y además abrirle la puerta a "entonces
// quiero el reembolso" de una reserva que él no honró.
//
// El tono es neutro y sin accuse: dice qué pasó y ofrece contacto. accusing al
// huésped de algo en un mensaje que queda guardado no deja nada bueno.
async function notifyNoShow(reserva, cliente, habitacion) {
  const mensaje = `Hola ${cliente.nombre}, te escribimos de Jaque al Rey.

No te registramos el ingreso (check-in) hoy para la reserva ${reserva.codigo}.
${datosReserva(reserva, habitacion)}

La reserva figura como no presentada. Si creés que fue un error, o si querés
 reprogramar tu estadía, escribinos al ${HOTEL_PHONE} y lo vemos.`;

  await notificarHuesped(reserva, cliente, habitacion, mensaje);
}

// Aviso al huesped de que su pago quedo confirmado.
//
// El flujo del hotel es: el huesped entra al sistema, transfiere al alias y
// despues el administrador marca el pago como Confirmado. Recien ahi se le
// avisa, porque antes el pago no esta acreditado: el aviso dice "presentate en
// recepcion con este codigo", y mandar eso con un pago sin confirmar seria
// decirle al huesped que tiene la habitacion reservada sin que el hotel haya
// recibido la plata.
async function notifyPagoConfirmado(reserva, cliente, habitacion, pago) {
  const total = Number(reserva.precio_total) || 0;
  const pagado = Number(pago.saldo_pagado) > 0 ? Number(pago.saldo_pagado) : Number(pago.monto);
  const resta = Math.max(0, total - pagado);
  const monto = Number(pago.monto).toLocaleString("es-AR");

  // El metodo casi siempre es alias, pero el admin tambien puede cargar un pago
  // en efectivo (si el huesped pago en el mostrador) y no hay que anunciar
  // "transferencia" cuando el dinero entro en efectivo.
  const como =
    pago.metodo === "efectivo"
      ? `Registramos tu pago en efectivo de $${monto}.`
      : `Registramos tu transferencia de $${monto}.`;

  const mensaje = `✅ *Pago recibido - Jaque al Rey*

Codigo de reserva: *${reserva.codigo}*
${datosReserva(reserva, habitacion)}

${como}
${resta > 0 ? `Saldo pendiente: $${resta.toLocaleString("es-AR")}\n` : "Tu reserva queda cubierta.\n"}
Presentate en recepcion con tu codigo de reserva.
El ingreso es a partir de las 14:00 hs y la salida antes de las 10:00 hs.
Cualquier consulta al ${HOTEL_PHONE}.`;

  await notificarHuesped(reserva, cliente, habitacion, mensaje);
}

// El huesped cancela solo desde la pagina publica: el hotel tiene que enterarse
// al toque porque la habitacion vuelve a quedar libre para esas fechas.
async function notifyCancelacionHuesped(reserva, cliente, habitacion, motivo) {
  if (!ADMIN_WHATSAPP) return;

  const mensaje = `❌ *Cancelacion de huesped - Jaque al Rey*
Cliente: ${cliente.nombre} ${cliente.apellido || ""}
Telefono: ${cliente.telefono}
Email: ${cliente.email}
${datosReserva(reserva, habitacion)}
Motivo: ${motivo || "no indicado"}

La habitacion quedo liberada para esas fechas.`;

  await sendTextMessage(ADMIN_WHATSAPP, mensaje);
}

/**
 * El huesped aviso que ya transfirio al alias.
 *
 * Va al hotel y no al huesped: lo que tiene que hacer el hotel es buscar esa
 * plata en la cuenta y recien ahi confirmar. Mandarselo al huesped no aporta
 * nada porque el unico que puede confirmarlo es el hotel.
 */
async function notifyPagoReportado(reserva, cliente, habitacion) {
  if (!ADMIN_WHATSAPP) return;

  const mensaje = `? *El huesped aviso que transfirio - Jaque al Rey*
Cliente: ${cliente.nombre} ${cliente.apellido || ""}
Telefono: ${cliente.telefono}
Email: ${cliente.email}
${datosReserva(reserva, habitacion)}

El huesped informo que ya hizo la transferencia. La reserva sigue *pendiente*
hasta que confirmes que la plata llego.`;

  await sendTextMessage(ADMIN_WHATSAPP, mensaje);
}

/**
 * La reserva se libero sola por no haberse pagado.
 *
 * Al huesped y no solo al hotel: si el cartel no llega, el unico que se entera
 * de que perdio la habitacion es el hotel, y el huesped descubre que no tiene
 * reserva cuando ya esta arriba. Ademas el mensaje dice como volver a reservar,
 * que es la conversion que se pierde al mandar un "se cancelo" seco.
 */
async function notifyReservaExpirada(reserva, cliente, habitacion, horas) {
  if (!ADMIN_WHATSAPP) return;

  const mensaje = `? *Reserva liberada por falta de pago - Jaque al Rey*
Cliente: ${cliente.nombre} ${cliente.apellido || ""}
Email: ${cliente.email}
${datosReserva(reserva, habitacion)}

No se recibio la transferencia dentro de las ${horas} h, asi que la reserva se
libero y la habitacion quedo disponible para otra persona.`;

  await sendTextMessage(ADMIN_WHATSAPP, mensaje);

  await notificarHuesped(
    reserva,
    cliente,
    habitacion,
    `Hola ${cliente.nombre}, tu reserva *${reserva.codigo}* quedo liberada porque no recibimos la transferencia dentro de las ${horas} horas. La habitacion vuelve a estar disponible para otra persona.\n\nSi queres volver a reservar, escribinos por aca y te la guardamos al toque.`
  );
}

/**
 * El huesped aviso que transfirio y la reserva sigue pendiente.
 *
 * Es el resumen diario que le falta al hotel: no le llega uno por cada reserva
 * (el aviso original ya llego con `notifyPagoReportado`), sino el recordatorio
 * de lo que tiene que ir a verificar al banco. Por eso va al admin y no al
 * huesped.
 */
async function notifyPagoReportadoPendiente(reserva, cliente, habitacion) {
  if (!ADMIN_WHATSAPP) return;

  const mensaje = `? *Pendiente de verificar - Jaque al Rey*
El huesped aviso que ya transfirio y la reserva sigue *pendiente*.
Cliente: ${cliente.nombre} ${cliente.apellido || ""}
Telefono: ${cliente.telefono}
${datosReserva(reserva, habitacion)}

No se libera sola (dice que pago): cuando veas la plata, confirmala desde el panel.`;

  await sendTextMessage(ADMIN_WHATSAPP, mensaje);
}

module.exports = {
  sendTextMessage,
  notifyNewReserva,
  notifyReservaConfirmada,
  notifyReservaCanceladaPorHotel,
  notifyNoShow,
  notifyCancelacionHuesped,
  notifyPagoConfirmado,
  notifyPagoReportado,
  notifyReservaExpirada,
  notifyPagoReportadoPendiente,
  HOTEL_PHONE,
};
