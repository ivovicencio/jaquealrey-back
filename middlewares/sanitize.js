function sanitizeInput(value) {
  if (typeof value === "string") {
    return value
      .replace(/<[^>]*>/g, "")
      .replace(/[\\$'"<>]/g, "")
      .trim();
  }
  return value;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== "object") return obj;

  const sanitized = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
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
  if (req.query) {
    const cleaned = {};
    for (const [key, value] of Object.entries(req.query)) {
      cleaned[key] = sanitizeInput(value);
    }
    req.query = cleaned;
  }
  if (req.params) {
    const cleaned = {};
    for (const [key, value] of Object.entries(req.params)) {
      cleaned[key] = sanitizeInput(value);
    }
    req.params = cleaned;
  }
  next();
}

module.exports = { sanitize };
