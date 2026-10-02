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
      return await client.get(key);
    } catch {
      return null;
    }
  },

  async set(key, value, ttl = CACHE_TTL) {
    if (!client) return;
    try {
      await client.set(key, value, "EX", ttl);
    } catch {}
  },

  /** Borra las claves que matchean el patron. */
  async del(pattern) {
    if (!client) return;
    try {
      const keys = await client.keys(pattern);
      if (keys.length > 0) await client.del(...keys);
    } catch {}
  },

  /** Vacia la cache entera. Se usa cuando cambia algo que hay que releer. */
  async invalidateAll() {
    if (!client) return;
    try {
      await client.flushdb();
    } catch {}
  },

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
