const axios = require("axios");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || null;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || null;
const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || null;
const HOTEL_PHONE = process.env.HOTEL_PHONE || "02942664320";

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

module.exports = {
  sendTextMessage,
  notifyNewReserva,
  notifyReservaConfirmada,
  notifyReservaCanceladaPorHotel,
  notifyCancelacionHuesped,
  HOTEL_PHONE,
};

