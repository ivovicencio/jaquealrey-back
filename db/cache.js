/**
 * Cache en Redis.
 *
 * Guarda en memoria lo que cambia muy seguido de consultarlo: la info del hotel
 * y lo que verian los endpoints.
 *
 * Es una aceleracion, nunca una dependencia. Si Redis no esta configurado o se
 * cae, `get` devuelve null y cada metodo sale con exito sin hacer nada: el
 * sistema responde igual, un poco mas lento. Por eso todos los metodos envuelven
 * su cuerpo en try/catch y silencian los errores de Redis.
 */

const Redis = require("ioredis");
const config = require("../config");

const REDIS_URL = config.cache.url;
const CACHE_TTL = config.cache.ttl;

// Prefijo de TODAS las claves de la app.
//
// Importa por dos motivos, no por gusto de nombres lindos:
//   1. `invalidateAll` borra por prefijo en vez de con FLUSHDB, asi una base de
//      Redis compartida (Railway, Upstash, o el Redis de otro servicio del
//      mismo proyecto) no se queda sin las claves del otro.
//   2. Al arrancar sobre una base con datos de una version anterior del proyecto
//      (mismo REDIS_URL, prefijo nuevo), no se pisan ni se cuelan claves viejas
//      que ya nadie va a invalidar con el criterio nuevo.
const PREFIJO = `${config.cache.namespace}:`;

/**
 * Recorre las claves que matchean el patron usando SCAN, y las borra.
 *
 * Ni KEYS ni FLUSHDB:
 *   - KEYS es O(N) sobre TODO el keyspace y bloquea el hilo principal de Redis
 *     mientras recorre. Con la base llena, cada alta de habitacion congelaba
 *     todas las lecturas del sitio entero.
 *   - FLUSHDB borra tambien claves de otros servicios.
 *
 * SCAN es incremental y no bloquea, y UNLINK libera la memoria en segundo plano
 * en vez de hacerlo de forma sincrona. COUNT es el hint de trabajo por
 * llamada, no un limite: el recorrido sigue hasta que el cursor vuelve a 0.
 */
async function borrarPorPatron(patron) {
  if (!client) return 0;

  let cursor = "0";
  let borradas = 0;

  try {
    do {
      const [siguiente, lote] = await client.scan(
        cursor,
        "MATCH",
        patron,
        "COUNT",
        200
      );
      cursor = siguiente;

      if (lote.length > 0) {
        await client.unlink(...lote);
        borradas += lote.length;
      }
    } while (cursor !== "0");
  } catch {
    // Sin cache no es un fallo: la proxima lectura recomputa desde la base.
    return borradas;
  }

  return borradas;
}

let client = null;

if (REDIS_URL) {
  client = new Redis(REDIS_URL, {
    // No conectar al crear el cliente: se conecta explicitamente abajo, asi un
    // arranque lento de Redis no frena el de la app.
    lazyConnect: true,

    retryStrategy(times) {
      if (times > 3) {
        console.warn("[Cache] Redis no disponible, operando sin cache");
        return null;
      }
      return Math.min(times * 200, 2000);
    },

    maxRetriesPerRequest: 3,
  });

  client.on("error", (err) => {
    console.warn("[Cache] Error Redis:", err.message);
  });

  client.connect().catch(() => {
    console.warn("[Cache] No se pudo conectar a Redis, modo sin cache");
    client = null;
  });
} else {
  console.warn("[Cache] REDIS_URL no configurada, modo sin cache");
}

module.exports = {
  /** Devuelve lo que Redis tenga para la clave, o null. */
  async get(key) {
    if (!client) return null;
    try {
      return await client.get(PREFIJO + key);
    } catch {
      return null;
    }
  },

  async set(key, value, ttl = CACHE_TTL) {
    if (!client) return;
    try {
      await client.set(PREFIJO + key, value, "EX", ttl);
    } catch {}
  },

  /**
   * Borra las claves que matchean el patron. El patron se aplica sobre las
   * claves CON prefijo, asi que `del("hotel:*")` nunca toca `otra_app:hotel:x`.
   */
  async del(pattern) {
    return borrarPorPatron(`${PREFIJO}${pattern}`);
  },

  /**
   * Vacia la cache de la app. Se usa cuando cambia algo que hay que releer.
   *
   * Borra por prefijo, no con FLUSHDB: si la base de Redis es compartida con
   * otro servicio, vaciarla entera le caeria a ese servicio sin que nadie lo
   * haya pedido.
   */
  async invalidateAll() {
    if (!client) return 0;
    const borradas = await borrarPorPatron(`${PREFIJO}*`);
    if (borradas) console.log("[Cache] Invalidadas", borradas, "claves");
    return borradas;
  },

  /**
   * Arma la clave. El prefijo lo agrega `get`/`set`/`del` por dentro, asi que
   * los llamadores no lo escriben nunca.
   */
  key(prefix, id) {
    return `${prefix}:${id}`;
  },

  /** Cierra la conexion. Se llama en el shutdown ordenado. */
  async close() {
    if (client) {
      try {
        await client.quit();
      } catch {}
    }
  },
};
