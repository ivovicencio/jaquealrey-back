const axios = require("axios");
const { executeQuery } = require("../db");
const { success, error } = require("../utils/response");

const mpCtrl = {};

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || null;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || "jaquealrey_webhook_secret";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

mpCtrl.createPreference = async (req, res, next) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return error(res, "MercadoPago no configurado", 500);
    }

    const { reserva_id } = req.body;

    const reservaData = await executeQuery(
      `SELECT r.*, h.nombre as habitacion_nombre, h.numero as habitacion_numero,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email
       FROM Reserva r
       JOIN Habitacion h ON r.habitacion_id = h.id
       JOIN Cliente c ON r.cliente_id = c.id
       WHERE r.id = $1`,
      [reserva_id]
    );

    if (reservaData.rows.length === 0) {
      return error(res, "Reserva no encontrada", 404);
    }

    const reserva = reservaData.rows[0];

    if (reserva.estado !== "Pendiente") {
      return error(res, "La reserva ya no está pendiente de pago", 400);
    }

    const response = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      {
        items: [
          {
            id: reserva.codigo,
            title: `Hotel Jaque al Rey - ${reserva.habitacion_nombre}`,
            description: `Reserva ${reserva.codigo} - ${reserva.habitacion_nombre} (#${reserva.habitacion_numero})`,
            quantity: 1,
            currency_id: "ARS",
            unit_price: Number(reserva.precio_total),
          },
        ],
        payer: {
          name: reserva.cliente_nombre,
          surname: reserva.cliente_apellido || "",
          email: reserva.cliente_email,
        },
        back_urls: {
          success: `${BASE_URL}/api/pagos/success`,
          pending: `${BASE_URL}/api/pagos/pending`,
          failure: `${BASE_URL}/api/pagos/failure`,
        },
        notification_url: `${BASE_URL}/api/pagos/webhook`,
        external_reference: reserva.id.toString(),
        auto_return: "approved",
      },
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return success(res, "Preferencia de pago creada", {
      preference_id: response.data.id,
      init_point: response.data.init_point,
      sandbox_init_point: response.data.sandbox_init_point,
    });
  } catch (err) {
    console.error("[MP] Error creando preferencia:", err.response?.data || err.message);
    next(err);
  }
};

mpCtrl.webhook = async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === "payment") {
      const paymentId = data.id;

      const paymentResponse = await axios.get(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        {
          headers: {
            Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          },
        }
      );

      const payment = paymentResponse.data;
      const reservaId = payment.external_reference;

      if (payment.status === "approved") {
        await executeQuery(
          "UPDATE Reserva SET estado = 'Confirmada' WHERE id = $1 AND estado = 'Pendiente'",
          [reservaId],
          { role: "admin" }
        );

        await executeQuery(
          `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
           VALUES ($1, 'Confirmada', 'Pago aprobado via MercadoPago', 'sistema', $2)`,
          [reservaId, req.ip || req.connection.remoteAddress]
        );

        console.log(`[MP] Pago aprobado para reserva ${reservaId}`);
      }
    }

    return res.status(200).json({ status: "1", msg: "OK" });
  } catch (err) {
    console.error("[MP] Error en webhook:", err.message);
    return res.status(200).json({ status: "1", msg: "OK" });
  }
};

mpCtrl.success = async (req, res) => {
  res.json({ status: "1", msg: "Pago exitoso. Reserva confirmada.", data: [] });
};

mpCtrl.pending = async (req, res) => {
  res.json({ status: "1", msg: "Pago pendiente. La reserva se confirmará cuando se acredite.", data: [] });
};

mpCtrl.failure = async (req, res) => {
  res.json({ status: "0", msg: "El pago no pudo completarse. Intentá de nuevo.", data: [] });
};

module.exports = mpCtrl;
