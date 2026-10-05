// Corre los archivos .sql de db/ contra Postgres, en orden o de a uno.
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
// Uso:
//   node db/run.js              aplica TODAS las migraciones, en orden
//   node db/run.js init.sql     aplica una sola
//   node db/run.js --list       muestra el orden sin tocar la base
//   npm run db:migrate          (o `npm run db:init`, `db:rls`, etc.)

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

// ---------------------------------------------------------------------------
// El orden de las migraciones
// ---------------------------------------------------------------------------
//
// Vive ACA y en ningun otro lado. Estaba duplicado en docker-compose.yml (los
// prefijos 01-, 02-...), en el comentario de security.sql y en los scripts de
// package.json: cuatro lugares que hubo que mantener de acuerdo. Ahora el orden
// se declara una vez y `docker-compose.yml` lo deriva de ahi.
//
// El orden NO es arbitrario, son dependencias reales:
//
//   init      crea las tablas
//   rol       crea jaquealrey_app. Tiene que existir ANTES de rls/pagos/
//             security: esos tres le hacen REVOKE y GRANT sobre el rol, y
//             PostgreSQL aborta el script si el rol no existe.
//   rls       politicas + revocaciones. Necesita las tablas de init y el rol.
//   pagos     tablas Pago/Configuracion y sus politicas. Necesita el rol.
//   seed      datos iniciales. Necesita las tablas de init y de pagos.
//   security  GRANTs finales. Va despues de las tablas nuevas para otorgar
//             permisos tambien sobre ellas.
//   optimize_indexes quita indices redundantes solo despues de que security.sql
//             haya creado el indice que respalda la constraint de exclusion.
const MIGRACIONES = [
  { archivo: "init.sql", desc: "esquema: tablas, indices, restricciones" },
  { archivo: "alojamientos.sql", desc: "tipos de alojamiento" },
  { archivo: "rol.sql", desc: "rol de aplicacion jaquealrey_app" },
  { archivo: "rls.sql", desc: "politicas RLS y revocaciones" },
  { archivo: "pagos.sql", desc: "tablas Pago y Configuracion" },
  { archivo: "seed.sql", desc: "datos iniciales" },
  { archivo: "recepcion.sql", desc: "estado En_Casa y disponibilidad" },
  { archivo: "push_tokens.sql", desc: "tokens para notificaciones push" },
  { archivo: "security.sql", desc: "GRANTs y endurecimiento" },
  { archivo: "optimize_indexes.sql", desc: "elimina indices redundantes" },
];

const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error("[db] Falta DATABASE_ADMIN_URL (para migraciones) o DATABASE_URL (para la app)");
  process.exit(1);
}

const args = process.argv.slice(2);

if (args[0] === "--list") {
  console.log("[db] Orden de migraciones:");
  MIGRACIONES.forEach((m, i) => {
    console.log(`  ${String(i + 1).padStart(2, " ")}. ${m.archivo.padEnd(14)} ${m.desc}`);
  });
  process.exit(0);
}

/** Aplica un .sql en su propia transaccion. */
async function aplicar(client, archivo) {
  const ruta = path.join(__dirname, archivo);

  if (!fs.existsSync(ruta)) {
    throw new Error(`no existe el archivo ${ruta}`);
  }

  const sql = fs.readFileSync(ruta, "utf8");

  // Todo en una transaccion: si una sentencia falla, no queda la base a medias.
  // Los .sql son idempotentes, asi que se puede volver a correr.
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`[db] ${archivo} aplicado correctamente.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

(async () => {
  const cliente = new Client({ connectionString });

  try {
    await cliente.connect();
  } catch (err) {
    console.error(`[db] No se pudo conectar: ${err.message}`);
    if (!process.env.DATABASE_ADMIN_URL && process.env.DATABASE_URL) {
      console.error("[db] Las migraciones necesitan un rol con permisos de creacion.");
      console.error(
        "[db] Define DATABASE_ADMIN_URL en el .env (el superusuario de Docker: jaquealrey)."
      );
    }
    process.exit(1);
  }

  // Sin argumento: todas, en orden.
  const pendientes = args.length ? MIGRACIONES.filter((m) => m.archivo === args[0]) : MIGRACIONES;

  if (!pendientes.length) {
    console.error(`[db] Archivo desconocido: ${args[0]}`);
    console.error(`[db] Disponibles: ${MIGRACIONES.map((m) => m.archivo).join(", ")}`);
    await cliente.end();
    process.exit(1);
  }

  try {
    for (const { archivo } of pendientes) {
      await aplicar(cliente, archivo);
    }
    await cliente.end();
    process.exit(0);
  } catch (err) {
    console.error(`[db] Fallo aplicando ${err.message}`);
    if (err.position) console.error(`     posicion ${err.position} (caracter ${err.position})`);
    await cliente.end().catch(() => {});
    process.exit(1);
  }
})();

module.exports = { MIGRACIONES };
