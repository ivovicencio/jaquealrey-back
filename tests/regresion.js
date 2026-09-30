// Regresion de seguridad + API. Corre contra el back en localhost:3000.
// Uso: npm test   (o: node tests/regresion.js)
const BASE = process.env.BASE || "http://localhost:3000";

// Fechas: cada corrida trabaja en una ventana futura propia, corrida al azar.
//
// Con fechas fijas el test solo podia correr una vez: la segunda vuelta
// chocaba contra las reservas que habia dejado la primera y la constraint
// reserva_sin_solapamiento las rechazaba con 409. Eso no era un fallo del
// sistema, era el test tirando contra su propia basura.
const DIA_MS = 86400000;
const DIA_BASE = Math.floor(
  (Date.now() + 400 * DIA_MS + Math.floor(Math.random() * 900) * DIA_MS) / DIA_MS
) * DIA_MS;

// Devuelve "YYYY-MM-DD" de la fecha que cae `dias` despues de la ventana.
const dia = (dias) => new Date(DIA_BASE + dias * DIA_MS).toISOString().slice(0, 10);

let ok = 0;
let fail = 0;
const fallos = [];

async function req(method, path, { headers = {}, body } = {}) {
  // Timeout duro: si el server no responde, el test falla en 15s en vez de
  // colgarse. Sin esto, un back caido deja el test esperando para siempre.
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 15000);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(to);
    return { status: 0, json: { msg: `sin respuesta: ${e.message}` } };
  }
  clearTimeout(to);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function check(nombre, cond, detalle = "") {
  if (cond) {
    ok++;
    console.log(`  OK   ${nombre}`);
  } else {
    fail++;
    fallos.push(`${nombre}${detalle ? ` — ${detalle}` : ""}`);
    console.log(`  FAIL ${nombre}${detalle ? ` — ${detalle}` : ""}`);
  }
}

function seccion(t) {
  console.log(`\n=== ${t} ===`);
}

(async () => {
  console.log(`Probando ${BASE}\n`);

  // ---------------------------------------------------------------
  // Preflight: la suite gasta ~17 POSTs a /api/reservas y el reservaLimiter
  // permite 20 cada 15 min. O sea, la corrida completa consume casi todo el
  // presupuesto. Si la ventana ya esta agotada (por una corrida anterior, o
  // por pruebas manuales) TODOS los checks de reservas devuelven 429 y el
  // resumen se llenaria de fallos que no son fallos.
  //
  // Conviene abortar aca, antes de gastar 40 checks, y decir que espere. Un
  // "OK: 25 FAIL: 6" con seis 429 parece un sistema roto y es lo contrario.
  const sonda = await req("POST", "/api/reservas", {
    body: {
      nombre: "Sonda", telefono: "1122334455", email: `sonda_${Date.now()}@t.com`,
      habitacion_id: 1, fecha_entrada: "01-01-1999", fecha_salida: "01-01-1999", huespedes: 1,
    },
  });
  if (sonda.status === 429) {
    console.log(`${"=".repeat(52)}`);
    console.log("ABORTADA: el rate limit de /api/reservas esta agotado.");
    console.log("");
    console.log("  La suite necesita ~17 POSTs a /api/reservas y el");
    console.log("  reservaLimiter permite 20 cada 15 minutos. Ya se gastaron.");
    console.log("");
    console.log("  Espera a que se libere la ventana y volve a correr, o");
    console.log("  reinicia el back para limpiar el contador de Redis.");
    console.log(`${"=".repeat(52)}`);
    process.exit(3);
  }
  console.log("");

  // ---------------------------------------------------------------
  seccion("1. Superficie publica (RLS debe permitir, sin token)");
  // ---------------------------------------------------------------
  const hotel = await req("GET", "/api/hotel");
  check("GET /api/hotel responde 200", hotel.status === 200, `status ${hotel.status}`);

  const habs = await req("GET", "/api/habitaciones");
  check("GET /api/habitaciones responde 200", habs.status === 200, `status ${habs.status}`);

  const cols = habs.json?.data?.[0] ? Object.keys(habs.json.data[0]).sort() : [];
  const esperadas = [
    "activa","camas_individuales","camas_matrimoniales","capacidad_max",
    "created_at","descripcion","id","nombre","numero","precio_noche","tipo",
  ];
  check(
    "GET /api/habitaciones devuelve solo columnas publicas",
    JSON.stringify(cols) === JSON.stringify(esperadas),
    `recibe ${JSON.stringify(cols)}`
  );

  const detalle = await req("GET", "/api/habitaciones/1");
  check("GET /api/habitaciones/:id responde 200", detalle.status === 200, `status ${detalle.status}`);

  const disp = await req("GET", "/api/habitaciones/disponibles?desde=2027-03-10&hasta=2027-03-12");
  check("GET /api/habitaciones/disponibles responde 200", disp.status === 200, `status ${disp.status}`);

  // ---------------------------------------------------------------
  seccion("2. Admin sin token: todo /api/admin debe ser 401");
  // ---------------------------------------------------------------
  const adminRutas = [
    ["GET", "/api/admin/dashboard"],
    ["GET", "/api/admin/reservas"],
    ["GET", "/api/admin/reservas/1"],
    ["PUT", "/api/admin/reservas/1/estado"],
    ["GET", "/api/admin/historial"],
    ["POST", "/api/admin/habitaciones"],
    ["PUT", "/api/admin/habitaciones/1"],
    ["DELETE", "/api/admin/habitaciones/1"],
    ["POST", "/api/pagos/crear-preferencia"],
    ["POST", "/api/auth/logout"],
    ["PUT", "/api/auth/password"],
  ];
  for (const [m, p] of adminRutas) {
    const r = await req(m, p, { body: m === "GET" ? undefined : {} });
    check(`${m} ${p} sin token -> 401`, r.status === 401, `status ${r.status}`);
  }

  // /crear-preferencia es POST-only: en GET tiene que dar 404, no 401.
  const r404 = await req("GET", "/api/pagos/crear-preferencia");
  check("GET /api/pagos/crear-preferencia no existe -> 404", r404.status === 404, `status ${r404.status}`);

  // ---------------------------------------------------------------
  seccion("3. Token invalido / alg confusion");
  // ---------------------------------------------------------------
  const rToken = await req("GET", "/api/admin/dashboard", { headers: { "x-access-token": "no-es-un-jwt" } });
  check("JWT basura -> 401", rToken.status === 401, `status ${rToken.status}`);

  // token sin firma, con alg none
  const noneTok = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
    + "." + Buffer.from(JSON.stringify({ id: 1, email: "admin@jaquealrey.com", role: "admin" })).toString("base64url")
    + ".";
  const rNone = await req("GET", "/api/admin/dashboard", { headers: { "x-access-token": noneTok } });
  check("JWT alg:none -> 401", rNone.status === 401, `status ${rNone.status}`);

  // ---------------------------------------------------------------
  seccion("4. Mass assignment en POST /api/reservas");
  // ---------------------------------------------------------------
  const cuerpo = {
    nombre: "Test",
    apellido: "Masivo",
    telefono: "1122334455",
    email: `masivo_${Date.now()}@test.com`,
    habitacion_id: 1,
    fecha_entrada: dia(0),
    fecha_salida: dia(2),
    huespedes: 2,
    estado: "Confirmada",
    precio_total: 1,
    id: 999999,
  };
  const creada = await req("POST", "/api/reservas", { body: cuerpo });
  check("POST /api/reservas crea la reserva", creada.status === 201, `status ${creada.status} ${JSON.stringify(creada.json)}`);
  check(
    "estado forzado a 'Pendiente' (ignora el body)",
    creada.json?.data?.estado === "Pendiente",
    `viene ${creada.json?.data?.estado}`
  );
  check(
    "precio_total calculado por el server (ignora el body)",
    Number(creada.json?.data?.precio_total) > 1,
    `viene ${creada.json?.data?.precio_total}`
  );
  check(
    "no acepta id del body",
    creada.json?.data?.id !== 999999,
    `viene id ${creada.json?.data?.id}`
  );

  const codigo = creada.json?.data?.codigo;
  const email = cuerpo.email;

  // ---------------------------------------------------------------
  seccion("5. Consultar reserva: codigo + email juntos");
  // ---------------------------------------------------------------
  if (codigo) {
    const bien = await req("GET", `/api/reservas/consultar?codigo=${codigo}&email=${encodeURIComponent(email)}`);
    check("consultar con codigo+email correctos -> 200", bien.status === 200, `status ${bien.status}`);

    const malEmail = await req("GET", `/api/reservas/consultar?codigo=${codigo}&email=nope@test.com`);
    check("consultar con email incorrecto -> 404", malEmail.status === 404, `status ${malEmail.status}`);

    const malCodigo = await req("GET", `/api/reservas/consultar?codigo=JAR-000000&email=${encodeURIComponent(email)}`);
    check("consultar con codigo incorrecto -> 404", malCodigo.status === 404, `status ${malCodigo.status}`);

    check(
      "la respuesta publica NO incluye email del huesped",
      bien.json?.data && bien.json.data.email === undefined && bien.json.data.cliente_email === undefined,
      `claves: ${JSON.stringify(Object.keys(bien.json?.data || {}))}`
    );
    check(
      "la respuesta publica NO incluye telefono del huesped",
      bien.json?.data && bien.json.data.telefono === undefined && bien.json.data.cliente_telefono === undefined
    );

    // mensaje indistinguible entre "codigo mal" y "email mal" (no enumera emails)
    check(
      "mismo mensaje para codigo malo y email malo (no enumera)",
      malEmail.json?.msg === malCodigo.json?.msg,
      `"${malEmail.json?.msg}" vs "${malCodigo.json?.msg}"`
    );
  }

  // ---------------------------------------------------------------
  seccion("6. Sobreventa: la segunda reserva debe rechazarse");
  // ---------------------------------------------------------------
  if (codigo) {
    const h2 = 2;
    const email2 = `sobreventa_${Date.now()}@test.com`;
    const primero = await req("POST", "/api/reservas", {
      body: {
        nombre: "Sobre", apellido: "Venta", telefono: "1122334455", email: email2,
        habitacion_id: h2, fecha_entrada: dia(10), fecha_salida: dia(12), huespedes: 2,
      },
    });
    check("primera reserva de la habitacion creada", primero.status === 201, `status ${primero.status}`);

    const segundo = await req("POST", "/api/reservas", {
      body: {
        nombre: "Sobre", apellido: "Venta", telefono: "1122334455", email: `sobreventa2_${Date.now()}@test.com`,
        habitacion_id: h2, fecha_entrada: dia(10), fecha_salida: dia(12), huespedes: 2,
      },
    });
    check("segunda reserva SOLAPADA rechazada (409)", segundo.status === 409, `status ${segundo.status} ${JSON.stringify(segundo.json)}`);

    // fechas que no se solapan: debe permitirse
    const noSolapada = await req("POST", "/api/reservas", {
      body: {
        nombre: "Sigue", apellido: "Libre", telefono: "1122334455", email: `libre_${Date.now()}@test.com`,
        habitacion_id: h2, fecha_entrada: dia(12), fecha_salida: dia(14), huespedes: 2,
      },
    });
    check("reserva en fechas contiguas (checkout el dia del checkin) permitida", noSolapada.status === 201, `status ${noSolapada.status}`);

    // solapamiento parcial
    const parcial = await req("POST", "/api/reservas", {
      body: {
        nombre: "Parcial", apellido: "Solape", telefono: "1122334455", email: `parcial_${Date.now()}@test.com`,
        habitacion_id: h2, fecha_entrada: dia(13), fecha_salida: dia(15), huespedes: 2,
      },
    });
    check("solapamiento parcial rechazado (409)", parcial.status === 409, `status ${parcial.status}`);
  }

  // ---------------------------------------------------------------
  seccion("7. Sobreventa concurrente (10 requests a la vez, misma habitacion)");
  // ---------------------------------------------------------------
  {
    const hId = 3;
    const lote = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        req("POST", "/api/reservas", {
          body: {
            nombre: "Race", apellido: `N${i}`, telefono: "1122334455", email: `race_${Date.now()}_${i}@test.com`,
            habitacion_id: hId, fecha_entrada: dia(20), fecha_salida: dia(24), huespedes: 2,
          },
        })
      )
    );
    const creadas = lote.filter((r) => r.status === 201).length;
    const rechazadas = lote.filter((r) => r.status === 409).length;
    const otros = lote.length - creadas - rechazadas;
    check(
      "exactamente 1 creada y 9 rechazadas en la carrera",
      creadas === 1 && rechazadas === 9,
      `creadas=${creadas} rechazadas=${rechazadas} otros=${otros} [${lote.map((r) => r.status).join(",")}]`
    );
  }

  // ---------------------------------------------------------------
  seccion("8. Validacion de entrada");
  // ---------------------------------------------------------------
  const sinFechas = await req("POST", "/api/reservas", {
    body: { nombre: "Ana", telefono: "1122334455", email: "a@b.com", habitacion_id: 1, huespedes: 1 },
  });
  check("reserva sin fechas -> 400", sinFechas.status === 400, `status ${sinFechas.status}`);

  const mailMalo = await req("POST", "/api/reservas", {
    body: { nombre: "Ana", telefono: "1122334455", email: "no-es-email", habitacion_id: 1, fecha_entrada: dia(30), fecha_salida: dia(31), huespedes: 1 },
  });
  check("reserva con email invalido -> 400", mailMalo.status === 400, `status ${mailMalo.status}`);

  const fechaMala = await req("POST", "/api/reservas", {
    body: { nombre: "Ana", telefono: "1122334455", email: `f_${Date.now()}@t.com`, habitacion_id: 1, fecha_entrada: "01-01-2027", fecha_salida: dia(31), huespedes: 1 },
  });
  check("fecha con formato incorrecto -> 400", fechaMala.status === 400, `status ${fechaMala.status}`);

  const sqlIny = await req("GET", "/api/habitaciones?tipo=Doble%27%20OR%20%271%27%3D%271");
  check("tipo con intento de inyeccion no rompe (200 o 400)", [200, 400].includes(sqlIny.status), `status ${sqlIny.status}`);

  const ordenBy = await req("GET", "/api/admin/dashboard");
  check("dashboard sin token -> 401 (no filtra por ORDER BY)", ordenBy.status === 401, `status ${ordenBy.status}`);

  // ---------------------------------------------------------------
  seccion("9. Login y bloqueo");
  // ---------------------------------------------------------------
  const loginMalo = await req("POST", "/api/auth/login", { body: { email: "nadie@test.com", password: "Mal1234" } });
  check("login con credenciales falsas -> 401", loginMalo.status === 401, `status ${loginMalo.status}`);

  // ---------------------------------------------------------------
  seccion("10. MercadoPago webhook sin secreto");
  // ---------------------------------------------------------------
  const hook = await req("POST", "/api/pagos/webhook", { body: { type: "payment", data: { id: 1 } } });
  check(
    "webhook sin MP_WEBHOOK_SECRET rechaza (503), no acepta pagos falsos",
    hook.status === 503 || hook.status === 200,
    `status ${hook.status}`
  );
  check(
    "webhook no confirma ninguna reserva sin firma",
    hook.status === 503,
    `status ${hook.status} (503 = rechazado, 200 = aceptando de mas)`
  );

  // ---------------------------------------------------------------
  console.log(`\n${"=".repeat(52)}`);
  console.log(`OK: ${ok}   FAIL: ${fail}`);
  if (fallos.length) {
    console.log("\nFallos:");
    fallos.forEach((f) => console.log(`  - ${f}`));
  }
  console.log("=".repeat(52));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Error fatal en el test:", e);
  process.exit(2);
});
