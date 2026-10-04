const crypto = require("crypto");

const PREFIX = "JAR";

// 8 hex = 32 bits, y "JAR-" + 8 entra justo en el VARCHAR(12) de Reserva.codigo
// (db/init.sql). No se puede subir a 12 hex porque no entra.
//
// Antes se pedían 6 bytes (12 hex) y se tiraba la mitad con substring(0, 6):
// quedaban 24 bits, o sea 16,7 millones de códigos. Por el cumpleaños, a las
// 10.000 reservas la probabilidad de al menos una colisión entre dos códigos
// pasa de 95%. Y el código es la credencial del huésped: es lo único que,
// junto con el email, permite consultar y cancelar una reserva sin cuenta.
const HEX_LENGTH = 8;

function generateCode() {
  const random = crypto
    .randomBytes(HEX_LENGTH / 2)
    .toString("hex")
    .toUpperCase();
  return `${PREFIX}-${random}`;
}

module.exports = { generateCode };