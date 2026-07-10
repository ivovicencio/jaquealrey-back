const pool = require("./pool");
const cache = require("./cache");

const VALID_ROLES = { admin: "admin", public: "public" };

async function executeQuery(text, params, options = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const role = VALID_ROLES[options.role] || "public";
    const userId = options.userId ? String(options.userId).replace(/[^0-9]/g, "") : "0";

    await client.query("SELECT set_config('app.role', $1, true)", [role]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);

    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, executeQuery, cache };
