//aca verifica el jwt para saber si el usuario esta autenticado y si tiene permisos de admin

const jwt = require("jsonwebtoken");
const { executeQuery } = require("../db");

const JWT_SECRET = process.env.JWT_SECRET;

//funcion para verificar si el token es correcto definicion la peticion, que respuesta va y que hacer despues
async function verifyToken(req, res, next) {
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

    // Revocacion: el token tiene que ser mas nuevo que la marca de la base.
    // Asi un logout (o un login nuevo) invalida los tokens anteriores, y no
    // alcanza con que el atacante "ya no figure en la UI" para seguir dentro.
    //
    // La comparacion va en SEGUNDOS, no en milisegundos. iat es un entero de
    // segundos, pero la marca viene de NOW() y tiene microsegundos: con
    // iat*1000 < marca, un token emitido en el mismo segundo que la marca
    // siempre da revoked, porque 704000 < 704646. O sea, el token del login
    // nacía muerto y el panel admin quedaba inaccesible. floors de ambos lados
    // deja pasar el token emitido justo después de la marca.
    if (req.role === "admin" && decoded.iat) {
      const marcado = await executeQuery(
        "SELECT tokens_validos_desde FROM cliente WHERE id = $1",
        [req.userId],
        { role: "admin", userId: req.userId }
      );

      if (marcado.rows.length === 0) {
        return res.status(401).json({ status: "0", msg: "Token inválido o expirado", data: [] });
      }

      const piso = marcado.rows[0].tokens_validos_desde;

      // Si la marca todavia no existe es un admin creado antes de este cambio:
      // se le pone NOW() para que su token vigente quede valido y los futuros
      // ya nazcan con la revocacion activa.
      if (!piso) {
        await executeQuery(
          "UPDATE cliente SET tokens_validos_desde = NOW() WHERE id = $1 AND tokens_validos_desde IS NULL",
          [req.userId],
          { role: "admin", userId: req.userId }
        );
      } else if (decoded.iat < Math.floor(new Date(piso).getTime() / 1000)) {
        return res.status(401).json({
          status: "0",
          msg: "Sesión revocada. Volvé a iniciar sesión.",
          data: [],
        });
      }
    }

    next();
  } catch (error) {
    // Solo los errores del JWT son 401. Si lo que fallo fue la base, responder
    // "token invalido" seria mentir: el token puede estar perfecto y lo que
    // se cayo fue Postgres. Se cierra igual (fail closed), pero como 500.
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({
        status: "0",
        msg: "Token inválido o expirado",
        data: [],
      });
    }
    return next(error);
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
