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
  let json;
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
    ["POST", "/api/auth/logout"],
    ["PUT", "/api/auth/password"],
  ];
  for (const [m, p] of adminRutas) {
    const r = await req(m, p, { body: m === "GET" ? undefined : {} });
    check(`${m} ${p} sin token -> 401`, r.status === 401, `status ${r.status}`);
  }

  // Las rutas de MercadoPago se eliminaron del proyecto. Ahora tienen que dar 404
  // en cualquier metodo, no 401: si algun dia se reactivan sin auth, este test
  // lo va a avisar.
  for (const p of ["/api/pagos/crear-preferencia", "/api/pagos/webhook"]) {
    for (const m of ["GET", "POST"]) {
      const r = await req(m, p, { body: m === "GET" ? undefined : {} });
      check(`${m} ${p} eliminado -> 404`, r.status === 404, `status ${r.status}`);
    }
  }

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
  seccion("6b. El filtro de disponibilidad tiene que excluir la ocupada");
  // ---------------------------------------------------------------
  // Este es el test del bug de disponibilidad. Antes del fix (funciones sin
  // SECURITY DEFINER) el SELECT sobre Reserva pasaba por RLS con ROL.PUBLICO,
  // RLS devolvia cero filas, el NOT EXISTS daba TRUE siempre, y estas tres
  // checks fallaban: la habitacion 2 estaba ocupada por la reserva de la
  // seccion 6 y aparecia igual como disponible.
  //
  // Reusa la reserva que la seccion 6 ya creo (habitacion 2, del 10 al 12) en
  // vez de crear otra: la suite esta al limite del reservaLimiter (ver el
  // preflight de mas arriba) y un POST mas la hacia fallar por rate limit.
  if (codigo) {
    const h2 = 2;

    // 1. El endpoint que mira el huesped antes de reservar.
    const disp = await req(
      "GET",
      `/api/habitaciones/disponibles?desde=${dia(10)}&hasta=${dia(12)}`
    );
    check("GET /api/habitaciones/disponibles responde 200", disp.status === 200, `status ${disp.status}`);
    const idsDisponibles = (disp.json?.data || []).map((h) => h.id);
    check(
      "la habitacion OCUPADA no aparece en /disponibles",
      !idsDisponibles.includes(h2),
      `aparecio la ${h2} en ${JSON.stringify(idsDisponibles)}`
    );

    // 2. El mismo filtro del catalogo, con disponible_desde/hasta.
    const catalogo = await req(
      "GET",
      `/api/habitaciones?disponible_desde=${dia(10)}&disponible_hasta=${dia(12)}`
    );
    check("GET /api/habitaciones con filtros de fecha responde 200", catalogo.status === 200, `status ${catalogo.status}`);
    const idsCatalogo = (catalogo.json?.data || []).map((h) => h.id);
    check(
      "la habitacion OCUPADA no aparece en el catalogo con fechas",
      !idsCatalogo.includes(h2),
      `aparecio la ${h2} en ${JSON.stringify(idsCatalogo)}`
    );

    // 3. La funcion suelta, que es la que llama validarHabitacion en el alta.
    //    Sin endpoint que la exponga, se pega directo a la base.
    const fn = await (async () => {
      require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
      const { executeQuery } = require("../db");
      return executeQuery("SELECT habitacion_disponible($1, $2, $3) AS d", [h2, dia(10), dia(12)]);
    })();
    check(
      "habitacion_disponible() dice FALSE para la ocupada",
      fn.rows[0]?.d === false,
      `devolvio ${JSON.stringify(fn.rows[0]?.d)}`
    );

    // Y que no se pase de rosca: la misma habitacion tiene que seguir
    // disponible en fechas en las que no esta ocupada. Si el "fix" fuera
    // marcar todo como no disponible, estas dos tambien lo detectan.
    const libre = await req("GET", `/api/habitaciones/disponibles?desde=${dia(30)}&hasta=${dia(32)}`);
    const idsLibres = (libre.json?.data || []).map((h) => h.id);
    check(
      "una habitacion SIN reservas sigue apareciendo como disponible",
      idsLibres.includes(h2),
      `no aparecio la ${h2} en ${JSON.stringify(idsLibres)}`
    );
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
  seccion("10. MercadoPago eliminado del proyecto");
  // ---------------------------------------------------------------
  // Los pagos son alias / efectivo / otro con confirmacion manual del hotel. No
  // hay pasarela, asi que no hay webhook que alguien pueda imitar para confirmar
  // pagos solo: los endpoints tienen que estar ausentes, no "rechazando".
  const hook = await req("POST", "/api/pagos/webhook", { body: { type: "payment", data: { id: 1 } } });
  check("webhook de MercadoPago no existe -> 404", hook.status === 404, `status ${hook.status}`);

  const pref = await req("POST", "/api/pagos/crear-preferencia", { body: { monto: 1000 } });
  check(
    "crear-preferencia no existe -> 404 (no se crea Checkout Pro)",
    pref.status === 404,
    `status ${pref.status}`
  );

  const sinFirmar = await req("POST", "/api/pagos", { body: { reserva_id: 1, monto: 1, metodo: "tarjeta" } });
  check(
    "'tarjeta' no es metodo de pago valido (solo alias, efectivo, otro)",
    sinFirmar.status === 401 || sinFirmar.status === 400,
    `status ${sinFirmar.status}`
  );

  // ---------------------------------------------------------------
  seccion("11. Pagos por alias");
  // ---------------------------------------------------------------
  // El huesped necesita ver el alias para transferir, asi que este endpoint es
  // publico. Lo que no puede es ver los pagos de nadie.
  const cfg = await req("GET", "/api/pagos/configuracion");
  check("datos de cobro publicos -> 200", cfg.status === 200, `status ${cfg.status}`);
  check(
    "expone el alias bancario",
    cfg.json?.data && Object.prototype.hasOwnProperty.call(cfg.json.data, "alias_bancario"),
    JSON.stringify(cfg.json?.data)
  );

  for (const ruta of ["/api/pagos", "/api/pagos/ingresos"]) {
    const r = await req("GET", ruta);
    check(`${ruta} sin token -> 401`, r.status === 401, `status ${r.status}`);
  }

  const pagoAnon = await req("POST", "/api/pagos", { body: { reserva_id: 1, monto: 1000 } });
  check("registrar pago sin token -> 401", pagoAnon.status === 401, `status ${pagoAnon.status}`);

  // ---------------------------------------------------------------
  seccion("12. Borrado silencioso (RLS sin politica DELETE)");
  // ---------------------------------------------------------------
  // Si a una tabla le falta la politica DELETE, el DELETE no da error: hace
  // match de cero filas y devuelve exito. Un endpoint de borrado creeria que
  // borro algo y en realidad no toco nada. Reserva no tiene politica DELETE a
  // proposito, y el privilegio esta revocado, asi que debe fallar ruidosamente.
  const delReserva = await req("DELETE", "/api/admin/reservas/999999");
  check(
    "DELETE sobre reserva no existe en la API (no se puede borrar una reserva)",
    delReserva.status === 404 || delReserva.status === 401,
    `status ${delReserva.status}`
  );

  // ---------------------------------------------------------------
  seccion("13. Validaciones de negocio que no llegan por HTTP");
  // ---------------------------------------------------------------
  // Estas dos se prueban sobre el controlador directamente, sin pasar por la
  // API, porque el flujo admin exige un token del que el test no tiene.
  // El problema es el mismo de las 48 de arriba: la ruta sin token responde 401
  // antes de llegar al controlador, asi que el test HTTP no puede distinguir
  // "la validacion funciona" de "nadie llego a probarla".
  // Las pruebas de esta seccion golpean la base real, asi que el pool necesita
  // credenciales. El server las carga en index.js con dotenv, pero el test se
  // corre directo con node tests/regresion.js y nunca pasa por ahi.
  //
  // Va antes del require del controlador y no despues: db/pool.js lee
  // process.env.DATABASE_URL al momento de construirse, y ese require ya crea
  // el pool. Si el dotenv va mas tarde, el pool queda con la password en
  // undefined y cada consulta muere con "SASL: client password must be a
  // string", que no dice nada del codigo que se estaba probando.
  require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

  const pagoCtrl = require("../controllers/pago.controller");
  const { executeQuery } = require("../db");

  // res falso: solo captura lo que el controlador devuelve.
  const fakeRes = () => {
    const r = { _status: 200, _json: null };
    r.status = (s) => { r._status = s; return r; };
    r.json = (j) => { r._json = j; return r; };
    return r;
  };

  // --- Configuracion: el recargo de tarjeta tiene que ser un porcentaje real.
  for (const [valor, debePasar, motivo] of [
    ["10", true, "10% es valido"],
    ["0", true, "0% es valido (sin recargo)"],
    ["300", false, "300% es absurdo"],
    ["-5", false, "negativo rompe los calculos"],
    ["diez", false, "texto no es un porcentaje"],
    ["", false, "vacio no es un porcentaje"],
  ]) {
    const r = fakeRes();
    await pagoCtrl.updateConfiguracionCobro(
      { body: { clave: "recargo_tarjeta_pct", valor }, ip: "127.0.0.1" },
      r,
      (e) => { r._status = 500; r._json = { msg: e.message }; }
    );
    const ok2 = debePasar ? r._status === 200 : r._status === 400;
    check(
      `recargo_tarjeta_pct="${valor}" ${ok2 ? "correcto" : "mal"} (${motivo})`,
      ok2,
      `status ${r._status} ${JSON.stringify(r._json)}`
    );
  }

  // El valor-good anterior dejo el 10% cargado. Se restaura para que la base
  // quede igual que estaba antes del test.
  const rReset = fakeRes();
  await pagoCtrl.updateConfiguracionCobro(
    { body: { clave: "recargo_tarjeta_pct", valor: "10" }, ip: "127.0.0.1" },
    rReset,
    () => {}
  );

  // Una clave numerica pero que no sea porcentaje pasa sin validacion extra.
  const rAlias = fakeRes();
  await pagoCtrl.updateConfiguracionCobro(
    { body: { clave: "alias_bancario", valor: "jaquealrey.mp" }, ip: "127.0.0.1" },
    rAlias,
    (e) => { rAlias._status = 500; rAlias._json = { msg: e.message }; }
  );
  check(
    "alias_bancario acepta texto libre",
    rAlias._status === 200,
    `status ${rAlias._status}`
  );

  const rDesconocida = fakeRes();
  await pagoCtrl.updateConfiguracionCobro(
    { body: { clave: "clave_inventada", valor: "x" }, ip: "127.0.0.1" },
    rDesconocida,
    (e) => { rDesconocida._status = 500; rDesconocida._json = { msg: e.message }; }
  );
  check(
    "clave de configuracion inexistente -> 400 (no se inventan filas)",
    rDesconocida._status === 400,
    `status ${rDesconocida._status}`
  );

  // --- Sobrepago al confirmar un pago pendiente.
  //
  // El caso: se carga un pago Pendiente por el total entero, despues se anula
  // otro que cubria todo, y al confirmar el primero la reserva queda pagada de
  // mas. createPago no lo cubre porque el pago nace Pendiente y no suma.
  const hab = await executeQuery(
    "SELECT id FROM Habitacion ORDER BY numero LIMIT 1", [], { role: "admin" }
  );
  const habId = hab.rows[0].id;

  const rReserva = await executeQuery(
    `INSERT INTO Reserva (codigo, cliente_id, habitacion_id, fecha_entrada, fecha_salida,
                          huespedes, precio_total, estado)
     VALUES ($1, (SELECT id FROM Cliente WHERE email = 'admin@jaquealrey.com' LIMIT 1),
             $2, $3, $4, 1, 100000, 'Confirmada')
     RETURNING id`,
    [`TEST-${Date.now().toString().slice(-6)}`, habId, dia(5), dia(7)],
    { role: "admin" }
  );
  const reservaId = rReserva.rows[0].id;

  // Pago pendiente de 60.000
  const rPendiente = fakeRes();
  await pagoCtrl.createPago(
    { body: { reserva_id: reservaId, monto: 60000, metodo: "efectivo", estado: "Pendiente" }, ip: "127.0.0.1" },
    rPendiente,
    (e) => { rPendiente._status = 500; rPendiente._json = { msg: e.message }; }
  );
  const pagoId = rPendiente._json?.data?.id;
  check("pago Pendiente de 60.000 creado", rPendiente._status === 200 && !!pagoId, `status ${rPendiente._status}`);

  // Se carga otro pago confirmado de 60.000: total pagado = 60.000, saldo 40.000.
  const rConfirmado = fakeRes();
  await pagoCtrl.createPago(
    { body: { reserva_id: reservaId, monto: 60000, metodo: "alias", estado: "Confirmado" }, ip: "127.0.0.1" },
    rConfirmado,
    (e) => { rConfirmado._status = 500; rConfirmado._json = { msg: e.message }; }
  );
  check("pago Confirmado de 60.000 creado", rConfirmado._status === 200, `status ${rConfirmado._status}`);

  // Ahora confirmar el pendiente llevaria a 120.000 sobre un total de 100.000.
  const rSobrepago = fakeRes();
  await pagoCtrl.updatePagoEstado(
    { params: { id: pagoId }, body: { estado: "Confirmado" }, ip: "127.0.0.1" },
    rSobrepago,
    (e) => { rSobrepago._status = 500; rSobrepago._json = { msg: e.message }; }
  );
  check(
    "confirmar pago que sobrepasa el total -> 400",
    rSobrepago._status === 400,
    `status ${rSobrepago._status} ${JSON.stringify(rSobrepago._json)}`
  );

  // Y confirmar uno que SI entra tiene que funcionar: el control no debe dejar
  // pasar los casos legitimos.
  const rLegal = fakeRes();
  await pagoCtrl.createPago(
    { body: { reserva_id: reservaId, monto: 10000, metodo: "efectivo", estado: "Pendiente" }, ip: "127.0.0.1" },
    rLegal,
    (e) => { rLegal._status = 500; rLegal._json = { msg: e.message }; }
  );
  const pagoLegalId = rLegal._json?.data?.id;
  const rConfLegal = fakeRes();
  await pagoCtrl.updatePagoEstado(
    { params: { id: pagoLegalId }, body: { estado: "Confirmado" }, ip: "127.0.0.1" },
    rConfLegal,
    (e) => { rConfLegal._status = 500; rConfLegal._json = { msg: e.message }; }
  );
  check(
    "confirmar pago que entra en el saldo -> 200 (no bloquea lo legitimo)",
    rConfLegal._status === 200,
    `status ${rConfLegal._status} ${JSON.stringify(rConfLegal._json)}`
  );

  // --- Carreras: dos admins confirmando el mismo pago a la vez.
  //
  // Con el UPDATE y el historial en consultas sueltas, dos confirmaciones
  // simultaneas del mismo pago pasaban las dos el chequeo de "ya estaba
  // confirmado" (las dos leian Pendiente) y las dos escribian historial. Ahora
  // el FOR UPDATE sobre el pago serializa y la segunda ve el estado ya
  // Confirmado.
  const rCarreraPago = fakeRes();
  await pagoCtrl.createPago(
    { body: { reserva_id: reservaId, monto: 5000, metodo: "efectivo", estado: "Pendiente" }, ip: "127.0.0.1" },
    rCarreraPago,
    (e) => { rCarreraPago._status = 500; rCarreraPago._json = { msg: e.message }; }
  );
  const idCarrera = rCarreraPago._json?.data?.id;

  const dosConfirmaciones = await Promise.all([1, 2].map(() => {
    const rr = fakeRes();
    return pagoCtrl
      .updatePagoEstado(
        { params: { id: idCarrera }, body: { estado: "Confirmado" }, ip: "127.0.0.1" },
        rr,
        (e) => { rr._status = 500; rr._json = { msg: e.message }; }
      )
      .then(() => rr);
  }));

  const exitosas = dosConfirmaciones.filter((r) => r._status === 200).length;
  const rechazadas = dosConfirmaciones.filter((r) => r._status === 400).length;
  check(
    "dos confirmaciones simultaneas del mismo pago: una sola gana",
    exitosas === 1 && rechazadas === 1,
    `200=${exitosas} 400=${rechazadas} ${JSON.stringify(dosConfirmaciones.map((r) => r._status))}`
  );

  // --- Carreras: dos pagos que juntos sobrepasan el total.
  //
  // Reserva de 100.000 con 30.000 ya confirmados (saldo 70.000). Se intentan
  // confirmar dos pendientes de 40.000 a la vez: el primero entra y deja
  // 70.000, el segundo lo pasaria a 110.000.
  //
  // Si la lectura del total y el UPDATE no estuvieran serializados, los dos
  // leerian 70.000 de saldo, los dos pasarian el control y ambos quedarian
  // confirmados: 110.000 cobrados sobre una reserva de 100.000.
  const rReservaCarrera = await executeQuery(
    `INSERT INTO Reserva (codigo, cliente_id, habitacion_id, fecha_entrada, fecha_salida,
                          huespedes, precio_total, estado)
     VALUES ($1, (SELECT id FROM Cliente WHERE email = 'admin@jaquealrey.com' LIMIT 1),
             $2, $3, $4, 1, 100000, 'Confirmada')
     RETURNING id`,
    // codigo <= 12 caracteres: es lo que acepta la columna Reserva.codigo.
    [`TESTC${Date.now().toString().slice(-7)}`, habId, dia(40), dia(42)],
    { role: "admin" }
  );
  const idReservaCarrera = rReservaCarrera.rows[0].id;

  await pagoCtrl.createPago(
    { body: { reserva_id: idReservaCarrera, monto: 30000, metodo: "efectivo", estado: "Confirmado" }, ip: "127.0.0.1" },
    fakeRes(),
    (e) => {}
  );

  const idsPendientes = [];
  for (let i = 0; i < 2; i++) {
    const rp = fakeRes();
    await pagoCtrl.createPago(
      { body: { reserva_id: idReservaCarrera, monto: 40000, metodo: "efectivo", estado: "Pendiente" }, ip: "127.0.0.1" },
      rp,
      (e) => { rp._status = 500; rp._json = { msg: e.message }; }
    );
    idsPendientes.push(rp._json?.data?.id);
  }

  const dosSobrepago = await Promise.all(
    idsPendientes.map((pid) => {
      const rr = fakeRes();
      return pagoCtrl
        .updatePagoEstado(
          { params: { id: pid }, body: { estado: "Confirmado" }, ip: "127.0.0.1" },
          rr,
          (e) => { rr._status = 500; rr._json = { msg: e.message }; }
        )
        .then(() => rr);
    })
  );

  const okCarrera = dosSobrepago.filter((r) => r._status === 200).length;
  const bloqCarrera = dosSobrepago.filter((r) => r._status === 400).length;
  check(
    "dos pagos simultaneos que juntos exceden el total: uno solo entra",
    okCarrera === 1 && bloqCarrera === 1,
    `200=${okCarrera} 400=${bloqCarrera} ${JSON.stringify(dosSobrepago.map((r) => r._status))}`
  );

  const totalTrasCarrera = await executeQuery(
    `SELECT COALESCE(SUM(monto), 0)::float AS total
       FROM Pago WHERE reserva_id = $1 AND estado = 'Confirmado'`,
    [idReservaCarrera],
    { role: "admin" }
  );
  check(
    "el saldo nunca queda en negativo tras la carrera",
    Number(totalTrasCarrera.rows[0].total) <= 100000,
    `pagado ${totalTrasCarrera.rows[0].total} de 100000`
  );

  // Limpieza: el rol de la app NO puede borrar pagos, y esa es la garantia que
  // este mismo test acaba de verificar. Para deshacer el fixture hay que entrar
  // como el owner de la base (POSTGRES_USER), que es el mismo camino que el
  // bootstrap de docker-compose. Es la unica parte del test con superusuario.
  const { Client } = require("pg");
  const duenho = new Client({
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    user: process.env.PGUSER || "jaquealrey",
    password: process.env.PGPASSWORD || "jaquealrey123",
    database: process.env.PGDATABASE || "jaquealrey",
  });
  await duenho.connect();
  try {
    await duenho.query("DELETE FROM Pago WHERE reserva_id = $1", [reservaId]);
    await duenho.query("DELETE FROM HistorialReserva WHERE reserva_id = $1", [reservaId]);
    await duenho.query("DELETE FROM Reserva WHERE id = $1", [reservaId]);
  } finally {
    await duenho.end();
  }

  // Este chequeo es solo sobre SU fixture: las reservas de las pruebas de
  // carrera de arriba siguen vivas todavia, se barren al final de la seccion 14.
  const limpio = await executeQuery(
    "SELECT COUNT(*)::int AS n FROM Reserva WHERE id = $1",
    [reservaId],
    { role: "admin" }
  );
  check("limpieza: no queda la reserva de este fixture", limpio.rows[0].n === 0, `quedan ${limpio.rows[0].n}`);

  const pagosLimpios = await executeQuery(
    "SELECT COUNT(*)::int AS n FROM Pago WHERE reserva_id = $1", [reservaId], { role: "admin" }
  );
  check("limpieza: no quedan pagos del fixture", pagosLimpios.rows[0].n === 0, `quedan ${pagosLimpios.rows[0].n}`);

  // ---------------------------------------------------------------
  seccion("14. La regresion no deja basura");
  // ---------------------------------------------------------------
  // Las secciones 5 a 8 crean reservas de verdad, porque probar sobre mocks no
  // probaria la constraint de sobreventa. Eso venia dejando ~25 reservas y sus
  // clientes en la base por corrida, y no es cosmético:
  //
  //   - el calendario de ocupación mostraba reservas de test
  //   - el reporte de ingresos arrastraba facturado de fechas 2028-2030
  //   - el listado admin era ilegible entre tanto fixture
  //
  // Ademas la corrida siguiente se cruzaba con las reservas que habia dejado
  // la anterior y las rechazaba con 409, sin que eso fuera un fallo real.
  //
  // La limpieza va con el owner de la base porque el rol de la app no puede
  // borrar reservas ni pagos: es justamente lo que se verifica arriba.
  {
    const { Client } = require("pg");
    const duenho = new Client({
      host: process.env.PGHOST || "localhost",
      port: parseInt(process.env.PGPORT || "5432", 10),
      user: process.env.PGUSER || "jaquealrey",
      password: process.env.PGPASSWORD || "jaquealrey123",
      database: process.env.PGDATABASE || "jaquealrey",
    });
    await duenho.connect();
    try {
      // Dos formas de reconocer un fixture: por el email del cliente ficticio
      // (mayus minus) o por el prefijo del codigo de reserva.
      //
      // El codigo hace falta porque los fixtures de pago (seccion 13) usan la
      // fila real del admin como cliente para no crear un cliente extra. Filtrar
      // solo por email dejaba esas reservas vivas despues de cada corrida.
      const W =
        "c.email ILIKE '%@test.com' OR c.email ILIKE '%@t.com' " +
        "OR r.codigo LIKE 'TEST-%' OR r.codigo LIKE 'TESTC%'";

      // Primero los pagos: ON DELETE RESTRICT impide borrar la reserva antes.
      const rPagos = await duenho.query(
        `DELETE FROM Pago
          WHERE reserva_id IN (
            SELECT r.id FROM Reserva r JOIN Cliente c ON c.id = r.cliente_id
             WHERE ${W}
          )`
      );
      const rHist = await duenho.query(
        `DELETE FROM HistorialReserva
          WHERE reserva_id IN (
            SELECT r.id FROM Reserva r JOIN Cliente c ON c.id = r.cliente_id
             WHERE ${W}
          )`
      );
      const rRes = await duenho.query(
        `DELETE FROM Reserva r
          USING Cliente c
          WHERE c.id = r.cliente_id
            AND (c.email ILIKE '%@test.com' OR c.email ILIKE '%@t.com'
                 OR r.codigo LIKE 'TEST-%' OR r.codigo LIKE 'TESTC%')`
      );
      const rCli = await duenho.query(
        `DELETE FROM Cliente WHERE email ILIKE '%@test.com' OR email ILIKE '%@t.com'`
      );

      const quietas = await duenho.query(
        `SELECT
           (SELECT COUNT(*)::int FROM Reserva) AS reservas,
           (SELECT COUNT(*)::int FROM Pago) AS pagos,
           (SELECT COUNT(*)::int FROM HistorialReserva) AS historial,
           (SELECT COUNT(*)::int FROM Cliente
             WHERE email NOT IN ('admin@jaquealrey.com','ivothaielvicencio@gmail.com')) AS clientes_extra`
      );
      const q = quietas.rows[0];
      check(
        `barrio los fixtures (${rRes.rowCount} reservas, ${rPagos.rowCount} pagos, ${rCli.rowCount} clientes)`,
        q.reservas === 0 && q.pagos === 0 && q.historial === 0,
        JSON.stringify(q)
      );
      check(
        "solo quedan los clientes reales del hotel",
        q.clientes_extra === 0,
        `clientes extra: ${q.clientes_extra}`
      );
    } finally {
      await duenho.end();
    }
  }

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
