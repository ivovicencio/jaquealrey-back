//aca verifica el jwt para saber si el usuario esta autenticado y si tiene permisos de admin

const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET; //busca la variable de entorno

//funcion para verificar si el token es correcto definicion la peticion, que respuesta va y que hacer despues
function verifyToken(req, res, next) {
  const token =
    req.headers["x-access-token"] ||
    (req.headers["authorization"] &&
      req.headers["authorization"].replace("Bearer ", ""));

  // Sin token no hay sesion: es 401, no 403. 403 seria "prohibido con credenciales".
  if (!token) {
    return res.status(401).json({
      status: "0",
      msg: "Token requerido",
      data: [],
    });
  }

  //si si hay token lo decodifica para ver que todo este correcto y si ta todo ok, continua si no estaria el token expirado
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

//una vez ya dentro ve si tiene permisos de admin
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

// El rol sale del token ya verificado por firma. verifyToken corre siempre antes.
function verifyAdminToken(req, res, next) {
  return verifyToken(req, res, () => verifyAdmin(req, res, next));
}

//exporta las funciones
module.exports = { verifyToken, verifyAdmin, verifyAdminToken };
