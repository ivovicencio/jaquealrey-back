//este archivo es para limpiar datos de entrada y evitar que inserten algun archivo malicioso

// Campos que nunca se tocan: si se "limpian" la contrasena deja de coincidir
// con el hash y el usuario nunca puede entrar.
const CAMPOS_LITERALES = new Set(["password", "password_actual", "password_nueva", "admin_secret"]);

// Se quitan etiquetas HTML y caracteres de control. NO se quitan comillas ni
// apostrofes: romperian nombres como O'Brien y la parametrizacion no aporta
// nada extra porque las consultas ya van siempre con $1, $2, ...
function sanitizeInput(value) {
  if (typeof value === "string") {
    return (
      value
        .replace(/<[^>]*>/g, "")
        // El punto de esta regex es justamente atrapar caracteres de control, asi
        // que la regla no-control-regex no aplica. Van escritos como escapes para
        // que el fuente no quede con bytes invisibles.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
    );
  }
  return value;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== "object") return obj;

  const sanitized = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (CAMPOS_LITERALES.has(key)) {
      sanitized[key] = value;
    } else if (typeof value === "string") {
      sanitized[key] = sanitizeInput(value);
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitize(req, _res, next) {
  if (req.body) req.body = sanitizeObject(req.body);
  if (req.params) {
    const cleaned = {};
    for (const [key, value] of Object.entries(req.params)) {
      cleaned[key] = CAMPOS_LITERALES.has(key) ? value : sanitizeInput(value);
    }
    req.params = cleaned;
  }
  next();
}

module.exports = { sanitize };
