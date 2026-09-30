// T1: recorre los flujos del cliente en un browser real, por CDP.
// No usa Playwright ni Selenium: se habla directo con Edge por el protocolo de
// DevTools, que es lo que hay disponible en la maquina.
//
// Uso: node tests/e2e-t1.js [baseUrl]
const WebSocket = require("ws");

const BASE_APP = process.argv[2] || "http://localhost:4200";
const CDP = process.env.CDP || "http://localhost:9222";

let ok = 0;
let fail = 0;
const fallos = [];
const erroresConsola = [];
const fallosRed = [];

function check(nombre, cond, detalle) {
  if (cond) {
    ok += 1;
    console.log(`  OK   ${nombre}`);
  } else {
    fail += 1;
    fallos.push(`${nombre} — ${detalle || ""}`.trim());
    console.log(`  FAIL ${nombre}${detalle ? ` — ${detalle}` : ""}`);
  }
}

const seccion = (t) => console.log(`\n=== ${t} ===`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// Cliente CDP minimo
// ------------------------------------------------------------------
class Cliente {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pendientes = new Map();
    this.oyentes = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pendientes.has(msg.id)) {
        const { res, rej } = this.pendientes.get(msg.id);
        this.pendientes.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        this.oyentes.forEach((f) => f(msg));
      }
    });
  }

  enviar(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pendientes.set(id, { res, rej }));
  }

  alEvento(f) { this.oyentes.push(f); }
}

async function nuevaPestana(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const c = new Cliente(ws);
  const { targetId } = await c.enviar("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await c.enviar("Target.attachToTarget", { targetId, flatten: true });
  await c.enviar("Page.enable", {}, sessionId);
  await c.enviar("Runtime.enable", {}, sessionId);
  await c.enviar("Network.enable", {}, sessionId);
  return { c, sessionId, targetId };
}

// Evalua expresion en la pagina y devuelve el valor serializado.
async function evaluar(c, sessionId, expresion) {
  const r = await c.enviar(
    "Runtime.evaluate",
    { expression: expresion, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || "excepcion al evaluar");
  }
  return r.result.value;
}

async function irA(c, sessionId, url) {
  await c.enviar("Page.navigate", { url }, sessionId);
  // Espera a que el documento quede listo y el Angular renderice.
  for (let i = 0; i < 60; i += 1) {
    await dormir(250);
    try {
      const listo = await evaluar(c, sessionId, "document.readyState === 'complete'");
      if (listo) {
        await dormir(600);
        return;
      }
    } catch { /* el contexto se recrea al navegar */ }
  }
}

const texto = (c, s) => evaluar(c, s, "document.body ? document.body.innerText : ''");

// ------------------------------------------------------------------
(async () => {
  console.log(`Probando ${BASE_APP} por CDP\n`);

  const versiones = await (await fetch(`${CDP}/json/version`)).json();
  const { c, sessionId } = await nuevaPestana(versiones.webSocketDebuggerUrl);

  // Recolecta errores de consola y de red durante toda la corrida.
  // Para los fallos de red hace falta correlacionar con la URL: loadingFailed
  // no la trae, asi que se guarda la ultima URL pedida por requestId.
  const urlDeRequest = new Map();
  c.alEvento((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      erroresConsola.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      erroresConsola.push(msg.params.exceptionDetails.exception?.description || "excepcion");
    }
    if (msg.method === "Network.requestWillBeSent") {
      urlDeRequest.set(msg.params.requestId, msg.params.request.url);
    }
    if (msg.method === "Network.loadingFailed") {
      const u = urlDeRequest.get(msg.params.requestId) || "(sin url)";
      fallosRed.push(`failed ${msg.params.errorText || "(sin errorText)"} ${u}`);
    }
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
      const u = msg.params.response.url;
      // Los 404 de assets ausentes son los gradientes de placeholder, no bugs.
      if (!u.includes("favicon")) fallosRed.push(`${msg.params.response.status} ${u}`);
    }
  });

  // ---------------------------------------------------------------
  seccion("1. Home");
  await irA(c, sessionId, `${BASE_APP}/`);
  const tHome = await texto(c, sessionId);
  check("home carga el nombre del hotel", /jaque/i.test(tHome), `primeras lineas: ${tHome.slice(0, 80)}`);
  check("home muestra el hero / CTA", /reserv/i.test(tHome), "no aparece la palabra reservar");
  const destacado = await evaluar(c, sessionId, "document.querySelectorAll('.room-card').length");
  check("home muestra habitaciones destacadas", destacado > 0, `encontre ${destacado} .room-card`);

  // ---------------------------------------------------------------
  seccion("2. Catalogo");
  await irA(c, sessionId, `${BASE_APP}/habitaciones`);
  const tCat = await texto(c, sessionId);
  const cards = await evaluar(c, sessionId, "document.querySelectorAll('.room-card').length");
  check("catalogo lista habitaciones", cards >= 10, `encontre ${cards} .room-card`);
  check("catalogo muestra el contador de resultados", await evaluar(c, sessionId, "!!document.querySelector('.results-count')"), "falta .results-count");
  check("catalogo muestra precios", /\$/.test(tCat), "no hay ningun $ en la pagina");

  // ---------------------------------------------------------------
  seccion("3. Filtros del catalogo");
  check("existe filtro por tipo (checkbox)", await evaluar(c, sessionId, "document.querySelectorAll('.sidebar input[type=checkbox]').length > 0"), "no hay checkboxes de tipo");
  check("existe filtro por capacidad (select)", await evaluar(c, sessionId, "!!document.querySelector('.sidebar select.form-select')"), "falta select.form-select");
  check("existe filtro por precio (range)", await evaluar(c, sessionId, "!!document.querySelector('.sidebar input.range-input')"), "falta input.range-input");

  // Filtra por "4 huespedes": tiene que reducir el listado.
  const antes = await evaluar(c, sessionId, "document.querySelectorAll('.room-card').length");
  await evaluar(c, sessionId, "(()=>{const s=document.querySelector('.sidebar select.form-select');s.value='4';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
  await dormir(1200);
  const despues = await evaluar(c, sessionId, "document.querySelectorAll('.room-card').length");
  check("el filtro de capacidad reduce el listado", despues < antes, `antes ${antes}, despues ${despues}`);
  check("el contador de resultados se actualiza", await evaluar(c, sessionId, "/habitacion\\(es\\) encontrada\\(s\\)/.test(document.querySelector('.results-count')?.textContent||'')"), "el contador no cuadra con el filtro");

  // ---------------------------------------------------------------
  seccion("4. Detalle de habitacion");
  const detalleOk = await evaluar(c, sessionId, "(()=>{const a=document.querySelector('.room-card a[href*=\"/habitaciones/\"]');if(!a)return false;a.click();return true;})()");
  if (detalleOk) {
    await dormir(2500);
    const tDet = await texto(c, sessionId);
    check("detalle abre una habitacion", tDet.length > 200, `pagina casi vacia (${tDet.length} chars)`);
    check("detalle tiene precio", /\$/.test(tDet), "sin precio");
    check("detalle tiene boton de reservar", /reserv/i.test(tDet), "no hay forma de reservar desde el detalle");
  } else {
    check("detalle abre una habitacion", false, "no hay link .room-card a /habitaciones/:id");
  }

  // ---------------------------------------------------------------
  seccion("5. Reserva completa (crear de verdad)");
  // Fechas propias de la corrida. El rango es amplio a proposito: con una
  // ventana chica, dos corridas seguidas caen en las mismas fechas y la
  // segunda choca contra la reserva que creo la primera. 3000 dias dan un
  // margen de colision despreciable.
  const DIA = 86400000;
  const base = new Date(Date.now() + (500 + Math.floor(Math.random() * 3000)) * DIA);
  const iso = (d) => new Date(base.getTime() + d * DIA).toISOString().slice(0, 10);
  const correo = `t1_${Date.now()}@example.com`;

  // Escribe en un input controlado por ngModel: hay que despachar 'input',
  // porque Angular no se entera de un value asignado por codigo.
  // Para checkbox hay que setear 'checked', no 'value': el value ya es "on"
  // de fábrica y marcarlo no hace nada, el modelo sigue en false.
  const setCampo = (id, valor) => evaluar(c, sessionId, `(() => {
    const el = document.getElementById('${id}');
    if (!el) return false;
    if (el.type === 'checkbox') {
      el.checked = ${valor === "on"};
    } else {
      el.value = ${JSON.stringify(valor)};
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  await irA(c, sessionId, `${BASE_APP}/habitaciones`);
  // Habitacion al azar, no siempre la primera: si dos corridas caen en la
  // misma habitacion comparten elCalendario y una pisa a la otra.
  await evaluar(c, sessionId, `(() => {
    const as = [...document.querySelectorAll('.room-card a[href*="/habitaciones/"]')];
    if (!as.length) return false;
    as[Math.floor(Math.random() * as.length)].click();
    return true;
  })()`);
  await dormir(2500);

  // Del detalle al formulario de reserva.
  const fueAlForm = await evaluar(c, sessionId, `(() => {
    const b = [...document.querySelectorAll('button, a')]
      .find(x => /reservar/i.test(x.textContent) && !/habitaciones/i.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check("el detalle tiene boton para reservar", fueAlForm, "no encontre boton Reservar");
  await dormir(2500);
  check("abre el formulario de reserva", await evaluar(c, sessionId, "!!document.getElementById('res-nombre')"),
    `estoy en ${await evaluar(c, sessionId, "location.pathname")}`);

  check("se completa el nombre", await setCampo("res-nombre", "Ana"), "no encontre #res-nombre");
  await setCampo("res-apellido", "Perez");
  await setCampo("res-email", correo);
  await setCampo("res-telefono", "1122334455");
  await setCampo("res-entrada", iso(0));
  await dormir(400);
  await setCampo("res-salida", iso(3));
  await dormir(600);

  // El resumen tiene que reflejar las noches elegidas antes de confirmar.
  const nochesTxt = await evaluar(c, sessionId, `(() => {
    const r = [...document.querySelectorAll('.summary-row')].find(x => /noches/i.test(x.textContent));
    return r ? r.textContent : '';
  })()`);
  const diagFechas = await evaluar(c, sessionId, `JSON.stringify({
    entrada: document.getElementById('res-entrada')?.value,
    salida: document.getElementById('res-salida')?.value,
    min: document.getElementById('res-entrada')?.min,
    nombre: document.getElementById('res-nombre')?.value
  })`);
  console.log(`  DIAG campos: ${diagFechas}`);
  check("el resumen calcula las noches", /3/.test(nochesTxt), `resumen dice: "${nochesTxt}"`);

  // La URL del formulario ya trae habitacion_id y precio. Se guarda para
  // poder repetir la reserva en la MISMA habitacion y fechas, que es lo que
  // tiene que rebotar por sobreventa.
  const qsForm = await evaluar(c, sessionId, "location.search");

  check("se acepta el consentimiento", await setCampo("res-consent", "on"), "falta #res-consent");
  await dormir(300);

  await evaluar(c, sessionId, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /confirmar reserva/i.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  })()`);

  // Espera a la pantalla de exito.
  let exito = false;
  for (let i = 0; i < 40; i += 1) {
    await dormir(400);
    exito = await evaluar(c, sessionId, "location.pathname.includes('reserva/exito')");
    if (exito) break;
  }
  const tExito = await texto(c, sessionId);
  const errorForm = await evaluar(c, sessionId, "document.querySelector('[role=alert]')?.textContent || '(sin error en pantalla)'");
  const where = await evaluar(c, sessionId, "location.pathname + location.search");
  check("la reserva se crea y lleva a la pantalla de exito", exito, `quedo en ${where} | error en pantalla: ${errorForm}`);
  const codigo = (tExito.match(/JAR-[0-9A-F]{6}/i) || [])[0];
  check("muestra un codigo de reserva", !!codigo, `no encontre un codigo JAR- en la pagina`);

  // ---------------------------------------------------------------
  seccion("6. Sobreventa desde el browser");
  if (codigo && qsForm) {
    // Misma habitacion y mismas fechas otra vez: tiene que rechazar.
    await irA(c, sessionId, `${BASE_APP}/reserva${qsForm}`);
    await dormir(2500);
    check("el formulario de sobreventa carga", await evaluar(c, sessionId, "!!document.getElementById('res-nombre')"),
      `no se abrio el formulario`);

    await setCampo("res-nombre", "Beto");
    await setCampo("res-apellido", "Gomez");
    await setCampo("res-email", `t1b_${Date.now()}@example.com`);
    await setCampo("res-telefono", "1122334455");
    await setCampo("res-entrada", iso(0));
    await dormir(400);
    await setCampo("res-salida", iso(3));
    await dormir(500);
    await setCampo("res-consent", "on");
    await dormir(300);
    await evaluar(c, sessionId, `(() => { const b = [...document.querySelectorAll('button')].find(x => /confirmar reserva/i.test(x.textContent)); if (b) b.click(); return true; })()`);
    await dormir(4000);
    const tSobre = await texto(c, sessionId);
    const rechazo = /no est[aá] disponible|no disponible|ya no hay|ocupad|error/i.test(tSobre);
    check("la sobreventa se rechaza en pantalla", rechazo, `no encontre aviso de indisponibilidad: ${tSobre.slice(0, 200)}`);
    check("la sobreventa no lleva a la pantalla de exito", !(await evaluar(c, sessionId, "location.pathname.includes('reserva/exito')")), "llego a la pantalla de exito con una reserva solapada");
  } else {
    check("la sobreventa se rechaza en pantalla", false, "no se pudo repetir la reserva (sin codigo o sin URL del formulario)");
  }

  // ---------------------------------------------------------------
  seccion("7. Consultar la reserva recien creada");
  if (codigo) {
    await irA(c, sessionId, `${BASE_APP}/consultar-reserva`);
    await dormir(1200);
    await setCampo("con-codigo", codigo).catch(() => null);
    // Los ids reales pueden diferir: se completan por position.
    await evaluar(c, sessionId, `(() => {
      const ins = [...document.querySelectorAll('input')];
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      if (ins[0]) set(ins[0], ${JSON.stringify(codigo)});
      if (ins[1]) set(ins[1], ${JSON.stringify(correo)});
      return ins.length;
    })()`);
    await dormir(400);
    await evaluar(c, sessionId, `(() => { const b = [...document.querySelectorAll('button')].find(x => /consultar|buscar/i.test(x.textContent)); if (b) b.click(); return true; })()`);
    await dormir(3000);
    const tConsultado = await texto(c, sessionId);
    check("la reserva creada se puede consultar por codigo", /pendiente|confirmada|reserva|habitaci/i.test(tConsultado) && tConsultado.includes(codigo),
      `no la encontro. pagina: ${tConsultado.slice(0, 200)}`);
  }

  // ---------------------------------------------------------------
  seccion("8. Buscar disponibilidad");
  await irA(c, sessionId, `${BASE_APP}/buscar-disponibilidad`);
  const tDisp = await texto(c, sessionId);
  check("la pagina de disponibilidad existe", /disponib/i.test(tDisp), `contenido: ${tDisp.slice(0, 100)}`);
  check("pide fechas", await evaluar(c, sessionId, "document.querySelectorAll('input[type=date]').length >= 2"),
    `encontre ${await evaluar(c, sessionId, "document.querySelectorAll('input[type=date]').length")} campos de fecha`);

  // ---------------------------------------------------------------
  seccion("9. Consulta por codigo (pagina)");
  // Ojo: la ruta es consultar-reserva, no consultar. Con /consultar el
  // wildcard de app.routes.ts redirige al home en silencio y la pagina
  // "pasa" sin probar nada.
  await irA(c, sessionId, `${BASE_APP}/consultar-reserva`);
  const tCons = await texto(c, sessionId);
  check("la pagina de consultar-reserva existe", /consult|c[oó]digo/i.test(tCons), `contenido: ${tCons.slice(0, 100)}`);
  const nInputs = await evaluar(c, sessionId, "document.querySelectorAll('input').length");
  check("pide codigo y email", nInputs >= 2, `encontre ${nInputs} inputs`);
  check("no desborda en desktop", await evaluar(c, sessionId, "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2"), "hay scroll horizontal");

  // ---------------------------------------------------------------
  seccion("10. Responsive mobile");
  await c.enviar("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  }, sessionId);
  for (const ruta of ["/", "/habitaciones", "/consultar-reserva", "/buscar-disponibilidad"]) {
    await irA(c, sessionId, `${BASE_APP}${ruta}`);
    const desborda = await evaluar(c, sessionId, "document.documentElement.scrollWidth - document.documentElement.clientWidth");
    check(`${ruta} no desborda en 390px`, desborda <= 2, `desborda ${desborda}px`);
  }
  await c.enviar("Emulation.clearDeviceMetricsOverride", {}, sessionId);

  // ---------------------------------------------------------------
  seccion("11. API caida (degradacion)");
  // Se bloquean SOLO las llamadas a la API, no toda la red. Si se corta la
  // red entera, Edge muestra su propia pagina de "no hay internet" y lo que
  // se estaria midiendo es el browser, no la app.
  await c.enviar("Network.setBlockedURLs", { urls: ["*/api/*"] }, sessionId);
  await irA(c, sessionId, `${BASE_APP}/habitaciones`);
  const tCaida = await texto(c, sessionId);
  check("con la API caida la pagina no queda en blanco", tCaida.length > 0, "la pagina quedo vacia");
  check("con la API caida avisa que no pudo cargar", /no pudimos cargar|no se pudo|revis[aá] la conexi[oó]n|reintent/i.test(tCaida),
    `contenido: ${tCaida.slice(0, 160)}`);
  check("con la API caida ofrece reintentar", await evaluar(c, sessionId, "[...document.querySelectorAll('button')].some(b=>/reintent/i.test(b.textContent))"), "no hay boton de reintentar");
  await c.enviar("Network.setBlockedURLs", { urls: [] }, sessionId);

  // ---------------------------------------------------------------
  seccion("12. Consola y red");
  const ruido = erroresConsola.filter((e) => !/favicon|DevTools|ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT|ERR_FAILED|Failed to load resource/i.test(e));
  check("sin errores de consola", ruido.length === 0, `${ruido.length}: ${ruido.slice(0, 3).join(" | ")}`);
  const redLimpia = fallosRed.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT|favicon|api\//i.test(e));
  check("sin 404 de assets", redLimpia.length === 0, `${redLimpia.length}: ${redLimpia.slice(0, 4).join(" | ")}`);

  // ---------------------------------------------------------------
  seccion("13. Panel admin (login, dashboard y logout)");
  await irA(c, sessionId, `${BASE_APP}/login`);
  await dormir(800);

  const setPorNombre = (name, valor) => evaluar(c, sessionId, `(() => {
    const el = document.querySelector('[name="${name}"]');
    if (!el) return false;
    el.value = ${JSON.stringify(valor)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  check("el login pide email", await setPorNombre("email", process.env.ADMIN_EMAIL || "admin@jaquealrey.com"), "no hay campo email");
  check("el login pide password", await setPorNombre("password", process.env.ADMIN_PASS || "!Admin123"), "no hay campo password");
  await dormir(300);
  await evaluar(c, sessionId, `(() => { const b = [...document.querySelectorAll('button')].find(x => /entrar|iniciar|ingresar|login/i.test(x.textContent)); if (b) b.click(); return true; })()`);

  let entro = false;
  for (let i = 0; i < 30; i += 1) {
    await dormir(400);
    entro = await evaluar(c, sessionId, "location.pathname.startsWith('/admin')");
    if (entro) break;
  }
  check("el login del admin entra al panel", entro, `quedo en ${await evaluar(c, sessionId, "location.pathname")}`);

  await dormir(1500);
  const tDash = await texto(c, sessionId);
  check("el dashboard muestra datos", tDash.length > 100, "el dashboard quedo vacio");
  check("el dashboard muestra reservas", /reserva/i.test(tDash), "no hay nada de reservas en el dashboard");

  // Logout: tiene que hablar con el servidor, no solo borrar el localStorage.
  const hizoLogout = await evaluar(c, sessionId, `(() => {
    const b = [...document.querySelectorAll('button, a')]
      .find(x => /salir|cerrar sesion|logout/i.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check("hay control de cerrar sesion", hizoLogout, "no encontre el boton de salir");

  await dormir(2500);
  const tokenQuedo = await evaluar(c, sessionId, "!!localStorage.getItem('token')");
  check("el logout borra el token del navegador", !tokenQuedo, "el token sigue en localStorage");
  check("el logout devuelve al login", await evaluar(c, sessionId, "location.pathname.includes('login') || location.pathname === '/'"),
    `quedo en ${await evaluar(c, sessionId, "location.pathname")}`);

  // Y lo importante: sin token no se puede volver al panel.
  await irA(c, sessionId, `${BASE_APP}/admin`);
  await dormir(1500);
  check("sin token el panel no abre", !(await evaluar(c, sessionId, "location.pathname.startsWith('/admin')")),
    `el panel abrio sin sesion: ${await evaluar(c, sessionId, "location.pathname")}`);
  const tAdminTras = await texto(c, sessionId);
  check("sin token no se filtran datos del admin", !/reserva pendiente|total de reservas/i.test(tAdminTras), "la pagina del admin mostro datos sin sesion");

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
  console.error("Error fatal en T1:", e);
  process.exit(2);
});
