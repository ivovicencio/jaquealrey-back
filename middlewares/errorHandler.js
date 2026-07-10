const PG_ERROR_CODES = {
  "23505": { status: 409, msg: "El registro ya existe (duplicado)" },
  "23503": { status: 400, msg: "Violación de clave foránea" },
  "22P02": { status: 400, msg: "Tipo de dato inválido" },
};

function errorHandler(err, req, res, _next) {
  if (err.code && PG_ERROR_CODES[err.code]) {
    const pgErr = PG_ERROR_CODES[err.code];
    return res.status(pgErr.status).json({
      status: "0",
      msg: pgErr.msg,
      data: [],
    });
  }

  if (err.status) {
    return res.status(err.status).json({
      status: "0",
      msg: err.message || "Error",
      data: [],
    });
  }

  console.error("[Error]", err);

  const isProduction = process.env.NODE_ENV === "production";
  return res.status(500).json({
    status: "0",
    msg: isProduction ? "Error interno del servidor" : err.message,
    data: [],
  });
}

module.exports = errorHandler;
