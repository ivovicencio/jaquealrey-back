const crypto = require("crypto");

const PREFIX = "JAR";
const CODE_LENGTH = 6;

function generateCode() {
  const random = crypto.randomBytes(CODE_LENGTH).toString("hex").toUpperCase();
  return `${PREFIX}-${random.substring(0, CODE_LENGTH)}`;
}

module.exports = { generateCode };
