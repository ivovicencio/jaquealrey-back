// Corre un archivo .sql de db/ contra Postgres.
//
// Reemplaza a los scripts `psql "$DATABASE_URL" < db/x.sql` por tres motivos:
//
//  1. psql no viene con Node. En una maquina limpia el comando no existe.
//  2. `$DATABASE_URL` es expansion de shell de Unix. npm en Windows corre los
//     scripts con cmd.exe, donde esa variable no se expande y psql recibe la
//     cadena literal "$DATABASE_URL".
//  3. Las migraciones necesitan un rol con CREATE / CREATEROLE, y
//     DATABASE_URL apunta a jaquealrey_app, que a proposito no los tiene
//     (es el rol sin privilegios que usa la app en runtime, el que hace que
//     RLS valga de verdad). Por eso se lee DATABASE_ADMIN_URL y solo ahi se
//     cae a DATABASE_URL.
//
// Uso:  node db/run.js init.sql
//   o:  npm run db:init

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const archivo = process.argv[2];

if (!archivo) {
  console.error("Uso: node db/run.js <archivo.sql>");
  console.error("Ejemplos: node db/run.js init.sql | rls.sql | security.sql | seed.sql");
  process.exit(1);
}

const ruta = path.join(__dirname, archivo);

if (!fs.existsSync(ruta)) {
  console.error(`[db] No existe el archivo: ${ruta}`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error("[db] Falta DATABASE_ADMIN_URL (para migraciones) o DATABASE_URL (para la app)");
  process.exit(1);
}

const sql = fs.readFileSync(ruta, "utf8");

(async () => {
  const client = new Client({ connectionString });

  try {
    await client.connect();
  } catch (err) {
    console.error(`[db] No se pudo conectar: ${err.message}`);
    if (!process.env.DATABASE_ADMIN_URL && process.env.DATABASE_URL) {
      console.error("[db] Las migraciones necesitan un rol con permisos de creacion.");
      console.error("[db] Define DATABASE_ADMIN_URL en el .env (el superusuario de Docker: jaquealrey).");
    }
    process.exit(1);
  }

  try {
    // Todo en una transaccion: si una sentencia falla, no queda la base a
    // medias. Los .sql son idempotentes, asi que se puede volver a correr.
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`[db] ${archivo} aplicado correctamente.`);
    await client.end();
    process.exit(0);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[db] Fallo aplicando ${archivo}:`);
    console.error(`     ${err.message}`);
    if (err.position) console.error(`     posicion ${err.position} (caracter ${err.position})`);
    process.exit(1);
  }
})();
