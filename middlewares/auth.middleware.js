const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

function verifyToken(req, res, next) {
  const token =
    req.headers["x-access-token"] ||
    (req.headers["authorization"] &&
      req.headers["authorization"].replace("Bearer ", ""));

  if (!token) {
    return res.status(403).json({
      status: "0",
      msg: "Token requerido",
      data: [],
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    req.userEmail = decoded.email;
    req.role = decoded.role || "cliente";
    next();
  } catch (error) {
    return res.status(401).json({
      status: "0",
      msg: "Token inválido o expirado",
      data: [],
    });
  }
}

function verifyAdmin(req, res, next) {
  if (req.role !== "admin") {
    return res.status(403).json({
      status: "0",
      msg: "Acción permitida solo para administradores",
      data: [],
    });
  }
  next();
}

module.exports = { verifyToken, verifyAdmin };
