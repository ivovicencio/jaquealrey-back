/**
 * Configuracion de cobro: los datos que el huesped necesita para transferir.
 *
 * Viven en la tabla `Configuracion` (clave/valor), que es de lectura publica
 * porque el huesped tiene que ver el alias antes de transferir.
 */

const { executeQuery, ROL } = require("../db");
const { AppError } = require("../utils/AppError");

// Claves que el huesped puede ver. Se listan una por una en vez de hacer
// SELECT * para que, si manana se guarda ahi un dato interno (un token de una
// pasarela, una clave de API), no quede expuesto por accidente al agregar una
// fila nueva.
const CLAVES_PUBLICAS = [
  "alias_bancario",
  "titular_cuenta",
  "banco_nombre",
  "moneda",
  "anticipo_porcentaje",
];

// Claves cuyo valor tiene que ser un porcentaje dentro de un rango sano.
//
// Sin esto, un error de tipeo deja el anticipo en "0" (el hotel deja de pedir
// seña) o en "300" (pide tres veces el total). Son valores que se comparan contra
// precios y se multiplican, asi que un NaN o un negativo se propaga a los totales
// de reserva y a los montos de pago.
const CLAVES_PORCENTAJE = new Set(["anticipo_porcentaje", "recargo_tarjeta_pct"]);

// Claves que el panel puede escribir.
//
// Allowlist, no "leer lo que hay en la tabla": el INSERT de abajo es un upsert,
// asi que sin esta lista cualquiera que llegue al endpoint con token de admin
// podria crear filas nuevas en Configuracion (una clave inventada queda
// guardada para siempre y despues la lee el endpoint publico).
const CLAVES_EDITABLES = new Set([...CLAVES_PUBLICAS, "recargo_tarjeta_pct"]);

/** Datos para el pago. Publico. */
async function obtener() {
  const result = await executeQuery(
    `SELECT clave, valor, descripcion
     FROM Configuracion
     WHERE clave = ANY($1)
     ORDER BY clave`,
    [CLAVES_PUBLICAS],
    ROL.PUBLICO
  );

  const config = {};
  for (const fila of result.rows) {
    config[fila.clave] = fila.valor;
  }
  return config;
}

/** Actualiza una clave (solo admin). */
async function actualizar({ clave, valor }) {
  if (!clave || typeof valor !== "string") {
    throw new AppError("Se requiere clave y valor", 400);
  }

  if (!CLAVES_EDITABLES.has(clave)) {
    throw new AppError(`Clave de configuracion no permitida: ${clave}`, 400);
  }

  if (CLAVES_PORCENTAJE.has(clave)) {
    // El trim va antes del Number a proposito: Number("") da 0 y Number("  ")
    // tambien, asi que sin esto un campo vaciado se guardaba como "0%" y el
    // hotel dejaba de cobrar el anticipo sin que nadie se enterara.
    const crudo = valor.trim();
    const pct = Number(crudo);
    if (crudo === "" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new AppError(`${clave} debe ser un porcentaje entre 0 y 100`, 400);
    }
  }

  // Upsert: la fila puede no existir todavia (una clave permitida que nunca se
  // guardo). INSERT ... ON CONFLICT resuelve los dos casos en una sola vuelta y
  // sin carrera entre el SELECT y el UPDATE.
  const result = await executeQuery(
    `INSERT INTO Configuracion (clave, valor, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
     RETURNING clave, valor`,
    [clave, valor],
    ROL.ADMIN
  );

  return result.rows[0];
}

/**
 * Porcentaje de anticipo con el que se puede confirmar una reserva.
 *
 * Es el mismo número que el huésped ve en la pantalla de pago, así que si
 * acá no se exige, el sistema le está minta: le muestra "30%" y después
 * confirma igual una reserva sin un peso. Por eso la regla de confirmar
 * (reserva.service.js) lee de acá y no de una constante.
 *
 * Se lee con el `client` de la transacción en curso y no con `obtener()`: abrir
 * una segunda conexión mientras se tiene un lock de fila sobre la reserva
 * traba el pool y, peor, lee el porcentaje fuera de la misma unidad atómica que
 * la decisión.
 *
 * @param {import('pg').PoolClient} client
 * @returns {Promise<number>} 0..100. 0 si no está configurado.
 */
async function leerAnticipoPorcentaje(client) {
  const result = await client.query(
    "SELECT valor FROM Configuracion WHERE clave = 'anticipo_porcentaje'"
  );

  const crudo = result.rows[0]?.valor;
  if (crudo === undefined || crudo === null || String(crudo).trim() === "") return 0;

  const pct = Number(String(crudo).trim());
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 0;

  return pct;
}

module.exports = {
  obtener,
  actualizar,
  leerAnticipoPorcentaje,
  CLAVES_PUBLICAS,
  CLAVES_PORCENTAJE,
  CLAVES_EDITABLES,
};
