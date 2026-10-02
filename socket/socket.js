const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config");

let io = null;

function verifySocketToken(raw) {
  if (!raw || typeof raw !== "string") return null;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch {
    return null;
  }
}

function resolveUser(socket, payload) {
  const fromPayload =
    typeof payload === "string" ? payload : payload && (payload.token || payload.accessToken);
  const decoded = verifySocketToken(fromPayload) || socket.data.user || null;
  if (!decoded) return null;
  return { id: decoded.id, email: decoded.email, role: decoded.role || "cliente" };
}

function initSocket(server) {
  io = new Server(server, {
    cors: {
      // Misma lista blanca que la de HTTP (app.js). Si divergieran, el socket
      // aceptaria origenes que la API ya esta rechazando.
      origin: config.http.allowedOrigins,
      methods: ["GET", "POST"],
    },
  });

  io.use((socket, next) => {
    const raw = socket.handshake.auth?.token || socket.handshake.query?.token;
    const decoded = verifySocketToken(raw);
    if (decoded) {
      socket.data.user = { id: decoded.id, email: decoded.email, role: decoded.role || "cliente" };
    }
    next();
  });

  io.on("connection", (socket) => {
    console.log("[Socket] Cliente conectado:", socket.id);

    socket.on("join-admin", (payload, ack) => {
      const user = resolveUser(socket, payload);

      if (!user) {
        const message = "Token requerido para unirse a la sala de administradores";
        console.warn("[Socket] join-admin rechazado (sin token):", socket.id);
        socket.emit("admin-error", { code: "UNAUTHORIZED", message });
        if (typeof ack === "function") ack({ ok: false, code: "UNAUTHORIZED", message });
        return;
      }

      if (user.role !== "admin") {
        const message = "Acción permitida solo para administradores";
        console.warn("[Socket] join-admin rechazado (rol " + user.role + "):", socket.id);
        socket.emit("admin-error", { code: "FORBIDDEN", message });
        if (typeof ack === "function") ack({ ok: false, code: "FORBIDDEN", message });
        return;
      }

      socket.join("admins");
      console.log("[Socket] Admin se unió a la sala:", socket.id, user.email);
      socket.emit("admin-joined", { email: user.email });
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("disconnect", () => {
      console.log("[Socket] Cliente desconectado:", socket.id);
    });
  });

  return io;
}

function getIO() {
  if (!io) {
    throw new Error("Socket.io no inicializado");
  }
  return io;
}

function emitNuevaReserva(reserva) {
  if (!io) return;
  io.to("admins").emit("nueva-reserva", reserva);
  console.log("[Socket] Evento nueva-reserva emitido a admins");
}

function emitReservaActualizada(reserva) {
  if (!io) return;
  io.to("admins").emit("reserva-actualizada", reserva);
  console.log("[Socket] Evento reserva-actualizada emitido a admins");
}

module.exports = { initSocket, getIO, emitNuevaReserva, emitReservaActualizada };
