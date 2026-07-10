const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || null;
const CACHE_TTL = parseInt(process.env.CACHE_TTL, 10) || 60;

let client = null;

if (REDIS_URL) {
  client = new Redis(REDIS_URL, {
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

  async del(pattern) {
    if (!client) return;
    try {
      const keys = await client.keys(pattern);
      if (keys.length > 0) await client.del(...keys);
    } catch {}
  },

  async invalidateAll() {
    if (!client) return;
    try {
      await client.flushdb();
    } catch {}
  },

  key(prefix, id) {
    return `${prefix}:${id}`;
  },

  async close() {
    if (client) {
      try {
        await client.quit();
      } catch {}
    }
  },
};
