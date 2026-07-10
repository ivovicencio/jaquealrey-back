const axios = require("axios");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || null;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || null;
const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || null;

function formatPhoneNumber(phone) {
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("54")) return cleaned;
  if (cleaned.startsWith("0")) return `54${cleaned.slice(1)}`;
  return `54${cleaned}`;
}

async function sendTextMessage(to, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("[WhatsApp] No configurado, ignorando mensaje");
    return;
  }

  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: "whatsapp",
        to: formatPhoneNumber(to),
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
    console.log("[WhatsApp] Mensaje enviado a", to);
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

module.exports = { sendTextMessage, notifyNewReserva };
