const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { executeQuery, ROL } = require("../db");

let io = null;

function verifySocketToken(raw) {
  if (!raw || typeof raw !== "string") return null;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    return jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ["HS256"],
    });
  } catch {
    return null;
  }
}

/**
 * Revocacion: el token tiene que ser mas nuevo que `tokens_validos_desde`.
 *
 * Es exactamente la misma comprobacion que hace verifyToken por HTTP, y tiene
 * que estar en los dos lados. Con solo la de HTTP, un logout Cerraba las
 * llamadas de la API pero dejaba vivo el socket: el admin "deslogueado" seguia
 * recibiendo "nueva-reserva" y "reserva-actualizada" en la sala `admins`, que
 * es exactamente el dato que el logout debía cortar.
 *
 * Devuelve `null` si el token es válido pero ya revocado, para que el llamador
 * lo trate como no autenticado.
 */
async function tokenRevocado(decoded) {
  if (!decoded || !decoded.id) return true;

  const marcado = await executeQuery(
    "SELECT tokens_validos_desde FROM cliente WHERE id = $1",
    [decoded.id],
    ROL.ADMIN
  );

  // Sin fila, el cliente no existe (fue borrado): el token no vale.
  if (marcado.rows.length === 0) return true;

  const piso = marcado.rows[0].tokens_validos_desde;

  // Marca todavia ausente: es un admin creado antes de que existiera la
  // revocacion. No se puede comparar, asi que se acepta el token (fail open
  // solo en este caso, que se corrige en el primer login).
  if (!piso) return false;

  return decoded.iat < Math.floor(new Date(piso).getTime() / 1000);
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

  io.use(async (socket, next) => {
    const raw = socket.handshake.auth?.token || socket.handshake.query?.token;
    const decoded = verifySocketToken(raw);

    // Firma invalida: se deja pasar sin usuario. No es un rechazo outright
    // porque el canal publico (opiniones del sitio) no necesita sesion; lo que
    // no se puede es dar identidad. Quien no tiene identidad simplemente no
    // entra a la sala de admins, mas abajo.
    if (decoded && (await tokenRevocado(decoded))) {
      console.warn("[Socket] Handshake con token revocado:", socket.id);
      socket.emit("session-revoked", {
        message: "Sesion revocada. Volve a iniciar sesion.",
      });
      return;
    }

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

/**
 * Cierra las conexiones de un cliente. Lo llama el logout.
 *
 * Sin esto, el token deja de servir para la API pero el socket sigue vivo y el
 * ex-admin sigue en la sala `admins` recibiendo las reservas de otros huéspedes
 * en tiempo real.
 */
function desconectarCliente(clienteId) {
  if (!io || !clienteId) return 0;

  let cerradas = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user && socket.data.user.id === clienteId) {
      socket.emit("session-revoked", { message: "Sesion revocada." });
      socket.disconnect(true);
      cerradas++;
    }
  }

  if (cerradas) console.log("[Socket] Sesiones cerradas para cliente", clienteId, "->", cerradas);
  return cerradas;
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

module.exports = {
  initSocket,
  getIO,
  desconectarCliente,
  emitNuevaReserva,
  emitReservaActualizada,
};
