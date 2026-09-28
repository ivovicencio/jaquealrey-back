
//se maneja la conexion a redis, sirve para guardar los datos en memoria que casi no cambian para responder mas rapido y no saturar la base de datos

const Redis = require("ioredis"); //traemos redis para la memoria local en cache

const REDIS_URL = process.env.REDIS_URL || null; //vemos donde esta redis
const CACHE_TTL = parseInt(process.env.CACHE_TTL, 10) || 60; //se configura por cuanto tiempo guardamos las cosas, en este caso, sesenta segundos

let client = null;

if (REDIS_URL) {
  client = new Redis(REDIS_URL, {
    lazyConnect: true, //aca significa basicamente que no te conectes automaticamente apenas creo el cliente, yo inicio la ocnexion

    //esto es por si cae
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
  //esto es dame todo lo que redis tenga
  async get(key) {
    if (!client) return null;
    try {
      return await client.get(key);
    } catch {
      return null;
    }
  },

  //guardar en redis
  async set(key, value, ttl = CACHE_TTL) {
    if (!client) return;
    try {
      await client.set(key, value, "EX", ttl);
    } catch {}
  },

  //para borrar
  async del(pattern) {
    if (!client) return;
    try {
      const keys = await client.keys(pattern);
      if (keys.length > 0) await client.del(...keys);
    } catch {}
  },

  //borra todo
  async invalidateAll() {
    if (!client) return;
    try {
      await client.flushdb();
    } catch {}
  },

  key(prefix, id) {
    return `${prefix}:${id}`;
  },

  //para cuando ya no necesita redis
  async close() {
    if (client) {
      try {
        await client.quit();
      } catch {}
    }
  },
};
