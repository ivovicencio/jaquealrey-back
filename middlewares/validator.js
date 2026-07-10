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
          errors.push(`${field.name}: formato de fecha inválido (YYYY-MM-DD)`);
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
