const { Server } = require("socket.io");

let io = null;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: (process.env.CORS_ORIGIN || "http://localhost:4200").split(",").map((o) => o.trim()),
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("[Socket] Cliente conectado:", socket.id);

    socket.on("join-admin", () => {
      socket.join("admins");
      console.log("[Socket] Admin se unió a la sala:", socket.id);
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
