//revis que lo que mande el cliente, tenga el formato correcto, entre lo que es minimo de caracteres, maximo, simbolos, etc.

// "¿2026-02-31" tiene el formato correcto pero no es un día que exista. Se
// construye la fecha con los numeros y se compara con el string original: si
// no coinciden, algo se paso de rango (dia 31 en febrero, mes 13, dia 0).
function esFechaReal(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;

  const fecha = new Date(Date.UTC(a, m - 1, d));
  return (
    fecha.getUTCFullYear() === a &&
    fecha.getUTCMonth() === m - 1 &&
    fecha.getUTCDate() === d
  );
}

function validate(schema, source = "body") {
  return (req, res, next) => {
    const data = req[source];
    const errors = [];

    for (const field of schema) {
      const value = data[field.name];

      if (field.required && (value === undefined || value === null || value === "")) {
        errors.push(`${field.name}: es requerido`);
        continue;
      }

      if (value === undefined || value === null || value === "") continue;

      if (field.type === "number") {
        const num = Number(value);
        if (isNaN(num)) {
          errors.push(`${field.name}: debe ser un número`);
          continue;
        }
        if (field.min !== undefined && num < field.min) {
          errors.push(`${field.name}: mínimo ${field.min}`);
        }
        if (field.max !== undefined && num > field.max) {
          errors.push(`${field.name}: máximo ${field.max}`);
        }
      }

      if (field.type === "string") {
        if (typeof value !== "string") {
          errors.push(`${field.name}: debe ser texto`);
          continue;
        }
        if (field.minLength !== undefined && value.length < field.minLength) {
          errors.push(`${field.name}: mínimo ${field.minLength} caracteres`);
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          errors.push(`${field.name}: máximo ${field.maxLength} caracteres`);
        }
        if (field.pattern && !field.pattern.test(value)) {
          errors.push(`${field.name}: formato inválido`);
        }
      }

      if (field.type === "email") {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          errors.push(`${field.name}: email inválido`);
        }
      }

      if (field.enum && !field.enum.includes(value)) {
        errors.push(`${field.name}: debe ser uno de ${field.enum.join(", ")}`);
      }

if (field.type === "date") {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(value)) {
          errors.push(`${field.name}: formato de fecha invǭlido (YYYY-MM-DD)`);
        } else if (!esFechaReal(value)) {
          // El regex acepta 2026-02-31. El string sigue compara bien contra
          // "hoy", asi que la reserva avanzaba hasta que Postgres la rechazaba
          // con un 22007 que nadie traduce y el huésped veia un 500.
          errors.push(`${field.name}: la fecha ${value} no existe en el calendario`);
        }
      }

      // Sin esto, un flag de un body JSON no tiene tipo: "false" es un string
      // truthy en JS y `if (forzar_sin_pago)` se cumple con el flag apagado.
      if (field.type === "boolean") {
        if (![true, false, 0, 1, "true", "false"].includes(value)) {
          errors.push(`${field.name}: debe ser true o false`);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        status: "0",
        msg: "Error de validación",
        data: errors,
      });
    }

    next();
  };
}

module.exports = { validate };
