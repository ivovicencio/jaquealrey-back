/**
 * Reservas: el corazon del sistema.
 *
 * Concentra tres cosas que es importante tener juntas porque se condicionan
 * entre si:
 *
 *  1. Disponibilidad. El SELECT de disponibilidad (habitacion_disponible) ES la
 *     primera linea de defensa contra la sobreventa: decide si la habitacion se
 *     ofrece, y con el mensaje de 409 que ve el huesped. La garantia final de que
 *     una habitacion no se venda dos veces sigue siendo la constraint
 *     `reserva_sin_solapamiento` de la base, porque es lo unico que cierra la
 *     ventana de carrera entre ese SELECT y el INSERT: dos requests que pasan el
 *     SELECT al mismo tiempo no se ven entre si, y la constraint los separa.
 *
 *     O sea: el SELECT evita la sobreventa en el caso normal (el huesped elige
 *     una habitacion ocupada y se le dice antes de llenar el formulario), y la
 *     constraint la evita en el caso patologico (dos clicks a la vez). Si el
 *     SELECT se rompe, la constraint sigue sosteniendo el negocio, pero el
 *     huesped llena el formulario entero antes de enterarse. Por eso
 *     habitacion_disponible es SECURITY DEFINER en db/init.sql: sin eso su
 *     SELECT sobre Reserva pasa por RLS con ROL.PUBLICO, RLS le devuelve cero
 *     filas, y la funcion dice "disponible" para todas las habitaciones.
 *
 *  2. Atomicidad. La reserva y su fila de historial se escriben juntas. Si el
 *     historial fallara por separado, quedaria una reserva creada sin ninguna
 *     trazabilidad, que es justo el registro que sirve para reconstruir que paso.
 *
 *  3. Reglas de cancelacion. El huesped cancela sin cuenta: se identifica con
 *     codigo de reserva + email, y hay una ventana de anticipacion minima.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const { executeQuery, withTransaction, ROL } = require("../db");
const { AppError } = require("../utils/AppError");
const { generateCode } = require("../utils/generateCode");
const { emitNuevaReserva, emitReservaActualizada } = require("../socket/socket");
const {
  notifyNewReserva,
  notifyCancelacionHuesped,
  notifyReservaConfirmada,
  notifyReservaCanceladaPorHotel,
  notifyNoShow,
  notifyPagoReportado,
} = require("../helpers/whatsappHelper");
const config = require("../config");
const clienteService = require("./cliente.service");
const { leerAnticipoPorcentaje } = require("./configuracion.service");
const notificationService = require("./notification.service");

const HORAS_CANCELACION = config.reglas.horasCancelacion;
const TELEFONO_HOTEL = config.whatsapp.hotelPhone;

/**
 * Texto legal versionado, con la fecha desde la que rige.
 *
 * Va ACA y no solo en el front a propósito: la tabla Consentimiento guarda un
 * snapshot del documento y su versión, y para que ese snapshot sea creíble, el
 * texto que se guardó tiene que ser el mismo que el huésped vio. Si el texto
 * viviera únicamente en el front, cambiarlo allí cambiaría lo que dice el
 * snapshot sin que nadie lo note, y el registro probaría cualquier cosa.
 *
 * El `documento` es el identificador de qué texto se aceptación, no el texto
 * entero: el snapshot completo vive en el front versionado. Guardar los 4 KB de
 * texto por cada reserva es lo que hace inservible la tabla.
 *
 * PASOS.md 24.5 y 50. Cuando cambie el texto, bump de VERSION y de VIGENTE_DESDE.
 */
const LEGAL = {
  VERSION: "1.0.0",
  VIGENTE_DESDE: "2026-01-01",
  DOCUMENTO: "terminos-y-condiciones",
};

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

// pg devuelve las columnas DATE como Date a la medianoche local, no como string.
function fechaISO(valor) {
  if (valor instanceof Date) {
    const mes = String(valor.getMonth() + 1).padStart(2, "0");
    const dia = String(valor.getDate()).padStart(2, "0");
    return `${valor.getFullYear()}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

// America/Argentina no aplica horario de verano desde 2009, asi que el offset es fijo.
const TZ_HOTEL = -3;

/** Horas que faltan hasta la medianoche de la fecha de entrada. Negativo = ya paso. */
function horasHastaEntrada(fechaEntrada) {
  const medianoche = Date.parse(`${fechaISO(fechaEntrada)}T00:00:00Z`);
  if (Number.isNaN(medianoche)) return 0;
  return (medianoche - (Date.now() + TZ_HOTEL * 3600000)) / 3600000;
}

/** El huesped puede cancelar mientras la reserva siga vigente y falte tiempo. */
function puedeCancelar(estado, fechaEntrada) {
  return (
    ["Pendiente", "Confirmada"].includes(estado) &&
    horasHastaEntrada(fechaEntrada) > HORAS_CANCELACION
  );
}

function nochesEntre(desde, hasta) {
  return Math.ceil((new Date(hasta) - new Date(desde)) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Consulta publica por codigo
// ---------------------------------------------------------------------------

// El huesped no tiene cuenta: se identifica con el codigo de reserva + su email.
// El WHERE exige ambos datos, asi que un email incorrecto no revela nada.
// No se devuelven email ni telefono: la consulta publica no los necesita.
const CONSULTA_POR_CODIGO = `
  SELECT r.id, r.codigo, r.fecha_entrada, r.fecha_salida, r.huespedes,
         r.precio_total, r.estado, r.notas, r.created_at,
         h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo,
         c.nombre as cliente_nombre, c.apellido as cliente_apellido
  FROM Reserva r
  JOIN Habitacion h ON r.habitacion_id = h.id
  JOIN Cliente c ON r.cliente_id = c.id
  WHERE UPPER(r.codigo) = UPPER($1) AND LOWER(c.email) = LOWER($2)`;

/** Consulta del huesped por codigo + email. */
async function consultarPorCodigo(codigo, email) {
  const result = await executeQuery(CONSULTA_POR_CODIGO, [codigo, email], ROL.ADMIN);

  if (result.rows.length === 0) {
    throw new AppError("No encontramos una reserva con ese codigo y email", 404);
  }

  const reserva = result.rows[0];
  const horas = horasHastaEntrada(reserva.fecha_entrada);

  return {
    ...reserva,
    puede_cancelar: puedeCancelar(reserva.estado, reserva.fecha_entrada),
    horas_para_cancelar: Math.max(0, Math.floor(horas)),
  };
}

/** Datos de contacto, para los avisos. Se piden aparte porque la consulta publica no los expone. */
async function obtenerContacto(reservaId) {
  const result = await executeQuery(
    `SELECT c.nombre as cliente_nombre, c.apellido as cliente_apellido,
            c.telefono as cliente_telefono, c.email as cliente_email,
            h.numero as habitacion_numero, h.nombre as habitacion_nombre
     FROM Reserva r
     JOIN Cliente c ON c.id = r.cliente_id
     JOIN Habitacion h ON h.id = r.habitacion_id
     WHERE r.id = $1`,
    [reservaId],
    ROL.ADMIN
  );

  const datos = result.rows[0];
  if (!datos) return null;

  return {
    cliente: {
      nombre: datos.cliente_nombre,
      apellido: datos.cliente_apellido,
      telefono: datos.cliente_telefono,
      email: datos.cliente_email,
    },
    habitacion: {
      numero: datos.habitacion_numero,
      nombre: datos.habitacion_nombre,
    },
  };
}

// ---------------------------------------------------------------------------
// Crear reserva
// ---------------------------------------------------------------------------

/**
 * Hashea la credencial muerta de un huesped recien creado, fuera del flujo de la
 * request.
 *
 * La contrasena es aleatoria y no se muestra a nadie: existe unicamente porque
 * `Cliente.password` es NOT NULL. Aun asi se hashea, pero con 10 rondas y fuera
 * del camino critico: bcryptjs usa las funciones asincronas de Node
 * (setImmediate), asi que el trabajo pesado va al thread pool. Con 12 rondas
 * serian ~235ms y cada huesped nuevo frenaria a los demos un cuarto de segundo.
 *
 * La diferencia contra 12 rondas es irrelevante para un hash que nadie va a
 * adivinar: no hay login que lo compare, no hay fuerza bruta contra el.
 */
async function hashearCredencialMorta(clienteId) {
  try {
    const tempPassword = crypto.randomBytes(24).toString("hex");
    const hash = await bcrypt.hash(tempPassword, 10);
    await clienteService.guardarPasswordHasheado(clienteId, hash);
  } catch (err) {
    console.warn(
      `[Reserva] No se pudo hashear la credencial del cliente ${clienteId}:`,
      err.message
    );
  }
}

/**
 * Resuelve (o crea) el Cliente de un huesped, DENTRO de la transacción de la
 * reserva.
 *
 * Hace falta dentro de la transacción por dos razones concretas:
 *
 *  1. Doble clic. El patrón viejo era SELECT y después INSERT, en dos
 *     transacciones distintas: dos clicks con el mismo email nuevo dan ambos
 *     SELECT con cero filas, uno se lleva un 23505 y el huésped ve "El registro
 *     ya existe (duplicado)", que es un mensaje de base de datos filtrado. El
 *     lock consultivo por email serializa a los dos: el segundo espera y
 *     cuando entra ya encuentra la fila.
 *
 *  2. Cliente huérfano. Con el INSERT fuera de la transacción, un 23P01 del
 *     INSERT de la Reserva (habitación tomada entre el SELECT de disponibilidad
 *     y el INSERT) dejaba commiteada la fila del Cliente sin ninguna reserva.
 *
 * No se sobreescriben datos de un cliente que ya existe, solo se completan los
 * vacíos. Si no, cualquiera que llene el formulario con el email de una víctima
 * le pisa el nombre y el teléfono y la reserva real de esa persona hereda datos
 * controlados por un atacante.
 */
async function obtenerOCrearCliente(client, { nombre, apellido, telefono, email }) {
  // hashtext() da un entero de 32 bits estable por email: es lo que necesita
  // pg_advisory_xact_lock. Con el prefijo "cliente:" no colisiona con los
  // locks que otras partes del sistema tomen sobre otros textos.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cliente:${email}`]);

  const existente = await client.query(
    `SELECT id, nombre, apellido, telefono, email
       FROM buscar_cliente_por_email($1)`,
    [email]
  );

  if (existente.rows.length > 0) {
    const Actualizado = await client.query(
      `UPDATE Cliente
          SET nombre = COALESCE(NULLIF(nombre, ''), $2),
              apellido = COALESCE(NULLIF(apellido, ''), $3),
              telefono = COALESCE(NULLIF(telefono, ''), $4)
        WHERE id = $1
        RETURNING id, nombre, apellido`,
      [existente.rows[0].id, nombre, apellido || "", telefono]
    );
    return { ...Actualizado.rows[0], esNuevo: false };
  }

  const creado = await client.query(
    `INSERT INTO Cliente (nombre, apellido, telefono, email, password)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nombre, apellido`,
    [nombre, apellido || "", telefono, email, "PENDIENTE"]
  );

  return { ...creado.rows[0], esNuevo: true };
}

/** Valida que la habitacion exista, este activa y tenga lugar. */
async function validarHabitacion(habitacion_id, huespedes, fecha_entrada, fecha_salida) {
  const habCheck = await executeQuery(
    "SELECT id, numero, nombre, precio_noche, capacidad_max FROM Habitacion WHERE id = $1 AND activa = true",
    [habitacion_id],
    ROL.PUBLICO
  );

  if (habCheck.rows.length === 0) {
    throw new AppError("Habitacion no encontrada o no disponible", 404);
  }

  const habitacion = habCheck.rows[0];

  if (huespedes > habitacion.capacidad_max) {
    throw new AppError(
      `La habitacion tiene capacidad maxima de ${habitacion.capacidad_max} huespedes`,
      400
    );
  }

  const disponible = await executeQuery(
    "SELECT habitacion_disponible($1, $2, $3)",
    [habitacion_id, fecha_entrada, fecha_salida],
    ROL.PUBLICO
  );

  if (!disponible.rows[0].habitacion_disponible) {
    throw new AppError("La habitacion no esta disponible en las fechas seleccionadas", 409);
  }

  return habitacion;
}

/**
 * El email del admin no se puede reusar como Cliente.
 *
 * Si un huesped reserva con el, la reserva queda atada al cliente_id del admin: el
 * panel muestra como suya una reserva que no es, los avisos de WhatsApp salen al
 * telefono del admin en vez del huesped, y la bitacora queda con datos de alguien
 * que no reservo. Ademas, si todavia no existe un admin, un huesped podria
 * "reservar" con ese email y crearse el Cliente antes de que el administrador
 * llegue a registrarse, dejando trancado el registro.
 *
 * El control va ANTES de buscar y antes de insertar: si quedara despues del
 * SELECT, el caso recien instalado seguiria abierto.
 */
function rechazarEmailDelAdmin(email) {
  const adminEmail = config.auth.adminEmail;
  if (adminEmail && String(email).trim().toLowerCase() === adminEmail) {
    throw new AppError(
      `Ese email no puede usarse para reservar. Contactanos al ${TELEFONO_HOTEL}`,
      400
    );
  }
}

function validarFechas(fecha_entrada, fecha_salida, { permitirFechaPasada = false } = {}) {
  // Fecha local del servidor (Argentina), no UTC: a las 22:00 de Buenos Aires
  // `toISOString()` ya dice manana y el huesped legitimo de hoy se ve rechazado.
  const hoy = fechaISO(new Date());

  if (!permitirFechaPasada && fecha_entrada < hoy) {
    throw new AppError("La fecha de entrada no puede ser anterior a hoy", 400);
  }
  if (fecha_salida <= fecha_entrada) {
    throw new AppError("La fecha de salida debe ser posterior a la de entrada", 400);
  }
}

/**
 * Crea una reserva.
 * - Sitio público → estadoInicial 'Pendiente', origen implícito web
 * - Walk-in admin  → estadoInicial 'Confirmada'
 */
async function crear(datos, ip, opciones = {}) {
  const {
    origen = "public",
    estadoInicial = "Pendiente",
    permitirEmailAdmin = false,
    permitirFechaPasada = false,
    realizadaPor = "cliente",
  } = opciones;

  const {
    nombre,
    apellido,
    telefono,
    email,
    habitacion_id,
    fecha_entrada,
    fecha_salida,
    huespedes,
    notas,
    acepta_terminos: aceptaRaw,
    terminos_version: versionRaw,
  } = datos;

  // La reserva web exige aceptación de términos, y no solo por prolijidad: el
  // registro en Consentimiento es la prueba de que el huésped los aceptó. Si se
  // aceptara el POST sin el flag, la tabla guardaría "el huésped aceptó la 1.0.0"
  // también para las reservas creadas por curl, por un test o por un bot. Eso no
  // es un registro de consentimiento, es un registro de que alguien pegó un
  // endpoint.
  //
  // El chequeo va acá y no solo en el validator de la ruta, porque `crear` también
  // la llaman otros servicios: el service es la última línea de defensa.
  if (origen === "public") {
    const acepta = aceptaRaw === true || aceptaRaw === "true" || aceptaRaw === 1;

    if (!acepta) {
      throw new AppError(
        "Tenés que aceptar los términos y condiciones para reservar",
        400
      );
    }

    // Si el backend ya Rigó la 1.0.0, lo correcto es fallar y que el front
    // vuelva a cargar el texto. Aceptar en silencio guardaría que el huésped
    // aceptó un texto que nunca vio.
    if (String(versionRaw || "").trim() !== LEGAL.VERSION) {
      throw new AppError(
        `La versión de los términos que enviaste (${versionRaw || "sin versión"}) no es la vigente (${LEGAL.VERSION}). Recargá la página.`,
        400
      );
    }
  }

  validarFechas(fecha_entrada, fecha_salida, { permitirFechaPasada });

  if (!permitirEmailAdmin) {
    rechazarEmailDelAdmin(email);
  }

  const habitacion = await validarHabitacion(habitacion_id, huespedes, fecha_entrada, fecha_salida);

  const noches = nochesEntre(fecha_entrada, fecha_salida);
  const precio_total = noches * parseFloat(habitacion.precio_noche);

  let reserva;
  let clienteNuevoId = null;
  try {
    reserva = await withTransaction(async (client) => {
      const cliente = await obtenerOCrearCliente(client, {
        nombre,
        apellido,
        telefono,
        email,
      });
      if (cliente.esNuevo) clienteNuevoId = cliente.id;

      // El código es lo que el huésped usa para reservar, consultar y cancelar
      // sin cuenta, así que una colisión no puede ser un error que ve el
      // huésped. Se reintenta con un código nuevo, y con SAVEPOINT porque un
      // 23505 aborta la transacción entera: sin rollback al savepoint, el
      // segundo intento fallaría con "current transaction is aborted" y el
      // reintento no serviría de nada.
      let creada = null;
      for (let intento = 0; intento < 5; intento++) {
        const codigo = generateCode();
        await client.query("SAVEPOINT reserva_insert");

        try {
          creada = await client.query(
            `INSERT INTO Reserva (codigo, cliente_id, habitacion_id, fecha_entrada, fecha_salida, huespedes, precio_total, notas, estado, origen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
              codigo,
              cliente.id,
              habitacion_id,
              fecha_entrada,
              fecha_salida,
              huespedes,
              precio_total,
              notas || null,
              estadoInicial,
              origen,
            ]
          );
          await client.query("RELEASE SAVEPOINT reserva_insert");
          break;
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT reserva_insert");
          if (!err || err.code !== "23505" || intento === 4) throw err;
        }
      }

      await client.query(
        `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
         VALUES ($1, 'Creada', $2, $3, $4)`,
        [
          creada.rows[0].id,
          `Reserva creada por ${cliente.nombre} ${cliente.apellido || ""} (${estadoInicial})`,
          realizadaPor,
          ip,
        ]
      );

      // Consentimiento (PASOS.md 24.5). El front lo exige en el formulario desde
      // el principio pero no lo persistía en ningún lado: sin versión, sin fecha y
      // sin IP, no hay nada que probar.
      //
      // Solo para la reserva web. Un walk-in lo acepta el recepcionista de viva
      // voz y no hay formulario que lo valide, así que inventar un registro ahí
      // sería mintiendo sobre el libro legal.
      //
      // `acepta_terminos` y `terminos_version` ya se validaron arriba, así que
      // acá solo queda persistir. La versión guardada es la del backend, no la
      // que mandó el cliente: son iguales porque el service rejectedó cualquier
      // otra, y usar la del servidor evita que alguien con un cliente viejo
      // manipulado escriba en el libro legal una versión arbitraria.
      if (origen === "public") {
        await client.query(
          `INSERT INTO Consentimiento (cliente_id, reserva_id, documento, version, ip_address)
           VALUES ($1, $2, $3, $4, $5)`,
          [cliente.id, creada.rows[0].id, LEGAL.DOCUMENTO, LEGAL.VERSION, ip || null]
        );
      }

      return creada.rows[0];
    }, ROL.ADMIN);
  } catch (err) {
    if (err && err.code === "23P01") {
      throw new AppError("La habitacion no esta disponible en las fechas seleccionadas", 409);
    }
    throw err;
  }

  // Fire-and-forget, y solo si la fila es nueva: hashear el password de un
  // cliente que ya existía pisaría la credencial que tiene (el admin) o la
  // que se usó para esa reserva anterior. La contrasena nunca se autentica,
  // pero pisarla igual es una pérdida de datos.
  if (clienteNuevoId) hashearCredencialMorta(clienteNuevoId).catch(() => {});

  emitNuevaReserva(reserva);

  // Solo avisamos por WhatsApp si es reserva online (Pendiente)
  if (estadoInicial === "Pendiente") {
    notifyNewReserva(reserva, { nombre, apellido, email, telefono }, habitacion);
  }

  // NOTIFICACIÓN PUSH: Avisamos al dueño/admin que hay una nueva reserva
  notificationService.notifyAdmins(
    "Nueva Reserva Recibida",
    `${nombre} ${apellido} reservó la habitación ${habitacion.numero}.`,
    { reserva_id: reserva.id, tipo: 'NUEVA_RESERVA' }
  );

  return reserva;
}

/**
 * Walk-in: el admin crea la reserva ya Confirmada.
 *
 * `origen: 'recepcion'` es lo que después permite separar en la pantalla Hoy a
 * los que entraron por el mostrador de los que Reserved por la web. Sin eso, un
 * huesped que reservó ayer y llega hoy es indistinguible de uno que nunca entró
 * a la web, y recepción no puede saber a quién hay que pedirle el documento.
 */
async function crearWalkIn(datos, ip) {
  return crear(datos, ip, {
    origen: "recepcion",
    estadoInicial: "Confirmada",
    permitirEmailAdmin: true,   // el recepcionista puede usar su propio email si hace falta
    permitirFechaPasada: true,  // permite walk-in del día
    realizadaPor: "admin",
  });
}

// ---------------------------------------------------------------------------
// Cancelar (huesped)
// ---------------------------------------------------------------------------

/**
 * Cancelacion solicitada por el huesped, sin cuenta.
 *
 * Una sola transaccion con `FOR UPDATE OF r`: el lock se mantiene hasta el
 * UPDATE, asi que dos intentos simultaneos no pueden cancelar dos veces la misma
 * reserva.
 */
async function cancelarPorHuesped({ codigo, email, motivo }, ip) {
  const resultado = await withTransaction(async (client) => {
    const encontrada = await client.query(`${CONSULTA_POR_CODIGO} FOR UPDATE OF r`, [
      codigo,
      email,
    ]);

    if (encontrada.rows.length === 0) {
      throw new AppError("No encontramos una reserva con ese codigo y email", 404);
    }

    const reserva = encontrada.rows[0];

    if (!["Pendiente", "Confirmada"].includes(reserva.estado)) {
      throw new AppError(`La reserva ya esta ${reserva.estado.toLowerCase()}`, 400);
    }

    if (horasHastaEntrada(reserva.fecha_entrada) <= HORAS_CANCELACION) {
      throw new AppError(
        `Para cancelaciones con menos de ${HORAS_CANCELACION} horas de anticipacion, contactanos al ${TELEFONO_HOTEL}`,
        400
      );
    }

    const updated = await client.query(
      "UPDATE Reserva SET estado = 'Cancelada', updated_at = NOW() WHERE id = $1 RETURNING *",
      [reserva.id]
    );

    await client.query(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'Cancelada', $2, 'cliente', $3)`,
      [reserva.id, motivo || "Cancelacion solicitada por el huesped", ip]
    );

    return updated.rows[0];
  }, ROL.ADMIN);

  emitReservaActualizada(resultado);

  // El hotel tiene que enterarse: la habitacion vuelve a quedar libre para esas
  // fechas y puede ofrecerla a otro huesped.
  const datos = await obtenerContacto(resultado.id);
  if (datos) {
    notifyCancelacionHuesped(resultado, datos.cliente, datos.habitacion, motivo);
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Reporte de pago (huesped)
// ---------------------------------------------------------------------------

/**
 * El huesped aviso que ya transfirio al alias.
 *
 * NO cambia el estado de la reserva ni registra un pago: sigue en `Pendiente`.
 * Motivo: el hotel no tiene pasarela ni webhook, el dinero entra a una cuenta
 * que no consulta la app. El unico que puede afirmar que la plata llego es el
 * admin mirando el banco, asi que confirmar lo hace el admin desde el panel.
 *
 * Lo que si hace es dejar el aviso en el historial, que es lo que le permite al
 * admin ver "este huesped dice que ya pago" y buscar la transferencia en vez de
 * tener que asumir que todas las reservas pendientes estan impagas.
 *
 * El huesped se identifica con codigo + email, igual que consultar y cancelar.
 */
async function reportarPagoPorHuesped({ codigo, email }, ip) {
  const resultado = await withTransaction(async (client) => {
    const encontrada = await client.query(`${CONSULTA_POR_CODIGO} FOR UPDATE OF r`, [codigo, email]);

    if (encontrada.rows.length === 0) {
      throw new AppError("No encontramos una reserva con ese codigo y email", 404);
    }

    const reserva = encontrada.rows[0];

    // Si ya esta confirmada o cancelada el aviso no dice nada nuevo, y si esta
    // cancelada seria ruido: el huesped tendria que reservar de nuevo.
    if (!["Pendiente"].includes(reserva.estado)) {
      throw new AppError(`La reserva ya esta ${reserva.estado.toLowerCase()}`, 400);
    }

    await client.query(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'PagoReportado', $2, 'cliente', $3)`,
      [
        reserva.id,
        "El huesped informo que realizo la transferencia. La reserva sigue pendiente hasta que el hotel confirme el pago.",
        ip,
      ]
    );

    // updated_at sola vez: el estado no cambia, pero el hotel tiene que ver que
    // la reserva se movio al entrar en "revisar pagos".
    await client.query("UPDATE Reserva SET updated_at = NOW() WHERE id = $1", [reserva.id]);

    return reserva;
  }, ROL.ADMIN);

  emitReservaActualizada(resultado);

  const datos = await obtenerContacto(resultado.id);
  if (datos) {
    notifyPagoReportado(resultado, datos.cliente, datos.habitacion);
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// Una sola fuente para la forma del detalle de una reserva.
//
// El PUT de estado la reutiliza. Antes devolvía `RETURNING *` (la fila pelada),
// y el panel reemplaza el objeto que tenía en pantalla por esa respuesta: al
// cambiar el estado desaparecían cliente_nombre, habitacion_numero y todo lo
// demás, y el detalle se quedaba en blanco hasta recargar a mano.
const SQL_DETALLE = `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre,
                             h.tipo as tipo,
                             c.nombre as cliente_nombre, c.apellido as cliente_apellido,
                             c.email as cliente_email, c.telefono as cliente_telefono
                      FROM Reserva r
                      JOIN Habitacion h ON r.habitacion_id = h.id
                      JOIN Cliente c ON r.cliente_id = c.id
                      WHERE r.id = $1`;

async function obtenerPorId(id) {
  const result = await executeQuery(SQL_DETALLE, [id], ROL.ADMIN);

  if (result.rows.length === 0) throw new AppError("Reserva no encontrada", 404);
  return result.rows[0];
}

/**
 * Listado paginado con filtros, mas lo pagado de cada reserva.
 *
 * El saldo se calcula en el mismo SELECT con un LEFT JOIN sobre la suma de pagos
 * confirmados, para que el panel no tenga que pedir los pagos de cada fila.
 */
async function listar({ estado, desde, hasta, pagina = 1, limite = 20 }) {
  const paginaNum = Math.max(1, parseInt(pagina, 10) || 1);
  const limiteNum = Math.min(100, Math.max(1, parseInt(limite, 10) || 20));
  const offset = (paginaNum - 1) * limiteNum;

  let query = `SELECT r.*, h.numero as habitacion_numero, h.nombre as habitacion_nombre, h.tipo as tipo,
                      c.nombre as cliente_nombre, c.apellido as cliente_apellido, c.email as cliente_email, c.telefono as cliente_telefono,
                      COALESCE(p.pagado, 0)::float as pagado,
                      (r.precio_total - COALESCE(p.pagado, 0))::float as saldo
               FROM Reserva r
               JOIN Habitacion h ON r.habitacion_id = h.id
               JOIN Cliente c ON r.cliente_id = c.id
               LEFT JOIN (
                   SELECT reserva_id, SUM(monto) AS pagado
                   FROM Pago
                   WHERE estado = 'Confirmado'
                   GROUP BY reserva_id
               ) p ON p.reserva_id = r.id
               WHERE 1=1`;
  const params = [];
  let i = 1;

  if (estado) {
    query += ` AND r.estado = $${i++}`;
    params.push(estado);
  }
  if (desde) {
    query += ` AND r.fecha_entrada >= $${i++}`;
    params.push(desde);
  }
  if (hasta) {
    query += ` AND r.fecha_salida <= $${i++}`;
    params.push(hasta);
  }

  const total = await executeQuery(`SELECT COUNT(*)::int FROM (${query}) sub`, params, ROL.ADMIN);

  query += " ORDER BY r.fecha_entrada DESC";
  query += ` LIMIT $${i} OFFSET $${i + 1}`;
  params.push(limiteNum, offset);

  const result = await executeQuery(query, params, ROL.ADMIN);

  return {
    reservas: result.rows,
    total: total.rows[0].count,
    pagina: paginaNum,
    total_paginas: Math.max(1, Math.ceil(total.rows[0].count / limiteNum)),
  };
}

/**
 * Cambia el estado de una reserva desde el panel.
 *
 * Se lee el estado anterior antes de actualizar: hace falta para no reavisar al
 * huesped si el admin guardo el mismo estado dos veces, y para tener los datos de
 * contacto del aviso.
 */
async function cambiarEstado(id, { estado, notas, forzar_sin_pago }, ip) {
  // El override llega desde un body JSON donde "false" es un string truthy.
  // Sin esta normalización, `forzar_sin_pago: "false"` esquivaría el anticipo,
  // que es exactamente lo que el flag no debe poder hacer.
  const forzar = forzar_sin_pago === true || forzar_sin_pago === "true" || forzar_sin_pago === 1;

  // Máquina de estados: solo se permiten estas transiciones
  const TRANSICIONES = {
    Pendiente: ["Confirmada", "Cancelada"],
    Confirmada: ["En_Casa", "Completada", "Cancelada"],
    En_Casa: ["Completada"],
    Cancelada: [],
    Completada: [],
  };

  const validos = Object.keys(TRANSICIONES);
  if (!validos.includes(estado)) {
    throw new AppError(`Estado invalido. Valores: ${validos.join(", ")}`, 400);
  }

  const reservaActualizada = await withTransaction(async (client) => {
    // 1. Lock de la fila para evitar carreras con el job de expiración
    const sel = await client.query(
      `SELECT r.id, r.codigo, r.estado, r.precio_total::float,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido,
              c.telefono as cliente_telefono,
              h.numero as habitacion_numero, h.nombre as habitacion_nombre
       FROM Reserva r
       JOIN Cliente c ON c.id = r.cliente_id
       JOIN Habitacion h ON h.id = r.habitacion_id
       WHERE r.id = $1
       FOR UPDATE OF r`,
      [id]
    );

    if (sel.rows.length === 0) {
      throw new AppError("Reserva no encontrada", 404);
    }

    const previa = sel.rows[0];

    // 2. Validar transición. Repetir el estado que ya tiene no es una
    // transición: el panel lo hace cada vez que se recarga el detalle y un 409
    // ahí confunde al recepcionista. Se responde OK sin escribir nada.
    const permitidas = TRANSICIONES[previa.estado] || [];
    if (previa.estado !== estado && !permitidas.includes(estado)) {
      throw new AppError(
        `No se puede pasar de ${previa.estado} a ${estado}`,
        409
      );
    }

    // 3. Confirmar exige el anticipo que el propio hotel le muestra al huesped
    // en la pantalla de pago. Sin esto el "30%" es decorativo: se confirma
    // cualquier reserva sin un peso y la deuda aparece al final, cuando ya no
    // se puede cobrar.
    if (estado === "Confirmada" && !forzar) {
      const pagado = await client.query(
        `SELECT COALESCE(SUM(monto), 0)::float AS total
         FROM Pago
         WHERE reserva_id = $1 AND estado = 'Confirmado'`,
        [id]
      );
      const totalPagado = Number(pagado.rows[0].total);
      const anticipoPct = await leerAnticipoPorcentaje(client);
      const requerido = (Number(previa.precio_total) * anticipoPct) / 100;

// El "> 0" de abajo es el piso cuando el anticipo está en 0: aún así no
    // se confirma una reserva que no recibió un peso, porque "sin anticipo" es
    // una decisión del hotel (0 en la config) y "sin cobrar nada" es otra.
      if (totalPagado < requerido || totalPagado <= 0) {
        const falta = Math.max(0, Math.ceil((requerido - totalPagado) * 100) / 100);
        throw new AppError(
          `No se puede confirmar: falta el anticipo (${anticipoPct}% = $${requerido.toFixed(2)}, ` +
            `cobrado $${totalPagado.toFixed(2)}${falta > 0 ? `, faltan $${falta.toFixed(2)}` : ""}). ` +
            "Si es cortesía o el pago entra después, usá forzar_sin_pago.",
          409
        );
      }
    }

    // 4. UPDATE atómico (solo si el estado sigue siendo el que leímos)
    const result = await client.query(
      `UPDATE Reserva
       SET estado = $1, updated_at = NOW()
       WHERE id = $2 AND estado = $3
       RETURNING *`,
      [estado, id, previa.estado]
    );

    if (result.rows.length === 0) {
      throw new AppError(
        "La reserva cambió de estado mientras se procesaba. Reintentá.",
        409
      );
    }

    // 5. Se devuelve la MISMA forma que el GET de detalle, no `RETURNING *`.
    // El panel pisa su objeto con esta respuesta, así que una fila pelada
    // deja la pantalla sin cliente ni habitación después de cada cambio.
    const detalleReserva = await client.query(SQL_DETALLE, [id]);

    // 6. Historial en la misma transacción. Un no-op no deja rastro: si la
    // bitácora dice "cambió a X" cuando ya estaba en X, el hotel no puede
    // reconstruir después qué pasó.
    if (result.rows[0].estado !== previa.estado) {
      const detalle = forzar
        ? `${notas || ""} (forzado sin pago)`.trim()
        : notas || null;

      await client.query(
        `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [id, `Estado cambiado a ${estado}`, detalle, ip]
      );
    }

    return {
      reserva: detalleReserva.rows[0],
      previa,
    };
  }, ROL.ADMIN);

  const { reserva, previa } = reservaActualizada;

  // 7. Notificaciones DESPUÉS del commit (no bloquean al admin)
  emitReservaActualizada(reserva);

  if (estado !== previa.estado) {
    const cliente = {
      nombre: previa.cliente_nombre,
      apellido: previa.cliente_apellido,
      telefono: previa.cliente_telefono,
    };
    const habitacion = {
      numero: previa.habitacion_numero,
      nombre: previa.habitacion_nombre,
    };

    if (estado === "Confirmada") {
      notifyReservaConfirmada(reserva, cliente, habitacion);
    } else if (estado === "Cancelada") {
      notifyReservaCanceladaPorHotel(reserva, cliente, habitacion);
    }
  }

  return reserva;
}
/**
 * Check-in: Confirmada (o Pendiente con override) → En_Casa.
 *
 * UNA sola transaccion para los tres cambios que tienen que pasar juntos:
 *   1. La reserva pasa a En_Casa con su check_in_at.
 *   2. La habitación pasa a estado_operativo = 'ocupada'.
 *   3. Se guarda documento y nacionalidad del huésped, y se marca verificado_en.
 *
 * Si se hicieran por separado y fallara el 2, la reserva quedaría En_Casa con la
 * habitación 'libre': el siguiente que la reserve la sobrevende y la constraint
 * salta recién en el INSERT, con el huésped esperando la llave.
 *
 * Por eso va todo en withTransaction y el FOR UPDATE es de la reserva: dos
 * recepcionistas pulsing "Dar llave" a la vez no pueden dejar la habitación en
 * un estado intermedio.
 *
 * Los dos bypass de siempre, con la misma normalización de `cambiarEstado`:
 * el body viene de un JSON donde "false" es un string truthy.
 */
async function checkIn(id, datos = {}, ip) {
  const {
    documento,
    nacionalidad,
    entregado_a,
    notas,
    forzar_sin_pago: forzarRaw,
  } = datos;
  const forzar = forzarRaw === true || forzarRaw === "true" || forzarRaw === 1;

  // El documento va con el DNI a la vista, así que pedirlo acá no es fricción.
  // En la web NO se pide (PASOS.md 24.1): ahí el DNI cuesta la reserva.
  if (!documento || String(documento).trim().length < 6) {
    throw new AppError("El documento del huésped es obligatorio para hacer el check-in", 400);
  }
  if (!nacionalidad || !String(nacionalidad).trim()) {
    throw new AppError("La nacionalidad del huésped es obligatoria para hacer el check-in", 400);
  }

  const resultado = await withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT r.id, r.codigo, r.estado, r.cliente_id, r.habitacion_id,
              r.precio_total::float, r.fecha_entrada,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido,
              c.telefono as cliente_telefono,
              h.numero as habitacion_numero, h.nombre as habitacion_nombre,
              h.estado_operativo
       FROM Reserva r
       JOIN Cliente c ON c.id = r.cliente_id
       JOIN Habitacion h ON h.id = r.habitacion_id
       WHERE r.id = $1
       FOR UPDATE OF r`,
      [id]
    );

    if (sel.rows.length === 0) {
      throw new AppError("Reserva no encontrada", 404);
    }

    const previa = sel.rows[0];

    // Idempotente: el panel recarga el detalle y el botón se puede volver a
    // tocar. No es un error, es un OK sin escribir nada.
    if (previa.estado === "En_Casa") {
      const detalle = await client.query(SQL_DETALLE, [id]);
      return { reserva: detalle.rows[0], previa, repetido: true };
    }

    // Solo entra una reserva confirmada. La Pendiente entra con override
    // explícito, que es el caso real del walk-in mal cargado: el huésped está
    // parado en el mostrador, no tiene sentido mandarlo a esperar un pago.
    if (previa.estado !== "Confirmada") {
      if (!(previa.estado === "Pendiente" && forzar)) {
        throw new AppError(
          `No se puede hacer check-in de una reserva ${previa.estado.toLowerCase()}. ` +
            "Tiene que estar Confirmada.",
          409
        );
      }
    }

    // La habitación tiene que estar en condiciones de recibir gente.
    //
    // Se rechazan 'mantenimiento' y 'limpieza', no solo el primero. Es el mismo
    // argumento de 22.3 al revés: si el check-out dejó la habitación en
    // 'limpieza' justamente para que nadie se la llevara sin limpiar, dar la
    // llave de una habitación en 'limpieza' anula esa protección. El botón de
    // "limpieza terminada" es lo que la devuelve a 'libre'.
    if (previa.estado_operativo === "mantenimiento" || previa.estado_operativo === "limpieza") {
      const como = previa.estado_operativo === "limpieza" ? "todavía sin limpiar" : "en mantenimiento";
      throw new AppError(
        `La habitación ${previa.habitacion_numero} está ${como}. ` +
          (previa.estado_operativo === "limpieza"
            ? 'Marcá "limpieza terminada" antes de dar la llave.'
            : "No se puede recibir huéspedes en una habitación en mantenimiento."),
        409
      );
    }

    // 1. La reserva
    const upd = await client.query(
      `UPDATE Reserva
       SET estado = 'En_Casa',
           check_in_at = COALESCE(check_in_at, NOW()),
           entregado_a = COALESCE($2, entregado_a),
           updated_at = NOW()
       WHERE id = $1 AND estado = $3
       RETURNING *`,
      [id, entregado_a || null, previa.estado]
    );

    if (upd.rows.length === 0) {
      throw new AppError(
        "La reserva cambió de estado mientras se procesaba. Reintentá.",
        409
      );
    }

    // 2. La habitación. Sin esto la reserva está En_Casa pero la habitación sigue
    // 'libre' y la siguiente reserva la toma.
    await client.query(
      "UPDATE Habitacion SET estado_operativo = 'ocupada' WHERE id = $1",
      [previa.habitacion_id]
    );

    // 3. Identidad del huésped (PASOS.md 24.2 y 24.3).
    //
    // Se pisa documento y nacionalidad, no se completan: si el cliente ya los
    // tenía cargados de un check-in anterior y ahora muestra otro documento, el
    // dato nuevo es el que vio recepción recién y el viejo quedó desactualizado.
    await client.query(
      `UPDATE Cliente
       SET documento = $2,
           nacionalidad = $3,
           verificado_en = NOW()
       WHERE id = $1`,
      [previa.cliente_id, String(documento).trim(), String(nacionalidad).trim()]
    );

    // El documento NO va en el detalle de texto. Queda en Cliente.documento con
    // verificado_en, que es donde se busca cuando hace falta. Copiarlo al
    // historial lo convertiría en PII duplicada, repartida en una tabla que se lee
    // por Exportar historial y no por su dueño.
    const detalle = [
      "Check-in. Documento verificado",
      entregado_a ? `Entregado a: ${entregado_a}` : null,
      notas || null,
      previa.estado === "Pendiente" ? "Ingresó sin confirmar (forzado)" : null,
    ]
      .filter(Boolean)
      .join(". ");

    await client.query(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'CheckIn', $2, 'admin', $3)`,
      [id, detalle, ip]
    );

    const detalleReserva = await client.query(SQL_DETALLE, [id]);

    return { reserva: detalleReserva.rows[0], previa, repetido: false };
  }, ROL.ADMIN);

  if (!resultado.repetido) {
    emitReservaActualizada(resultado.reserva);
  }

  return resultado.reserva;
}

/**
 * Check-out: En_Casa → Completada. La habitación pasa a 'limpieza'.
 *
 * 'limpieza' y no 'libre', a propósito (PASOS.md 22.3): si volviera sola a
 * 'libre', la reserva siguiente se la lleva alguien a quien todavía nadie limpió
 * la habitación. El paso a 'libre' es un botón explícito de "limpieza terminada".
 *
 * El saldo se cierra ANTES (PASOS.md 22.4). Un check-out que deja plata impaga
 * sin avisar es el mismo agujero del paso 3 de la Fase 1: la habitación ya está
 * liberada y la deuda disappeared con ella. Si debe plata, el check-out devuelve
 * 409 con el monto y hay que mandarlo con `forzar_sin_pago` explícito, que queda
 * en la bitácora.
 */
async function checkOut(id, datos = {}, ip) {
  const { notas, forzar_sin_pago: forzarRaw } = datos;
  const forzar = forzarRaw === true || forzarRaw === "true" || forzarRaw === 1;

  const resultado = await withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT r.id, r.codigo, r.estado, r.habitacion_id, r.precio_total::float,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido,
              c.telefono as cliente_telefono,
              h.numero as habitacion_numero, h.nombre as habitacion_nombre
       FROM Reserva r
       JOIN Cliente c ON c.id = r.cliente_id
       JOIN Habitacion h ON h.id = r.habitacion_id
       WHERE r.id = $1
       FOR UPDATE OF r`,
      [id]
    );

    if (sel.rows.length === 0) {
      throw new AppError("Reserva no encontrada", 404);
    }

    const previa = sel.rows[0];

    if (previa.estado === "Completada") {
      const detalle = await client.query(SQL_DETALLE, [id]);
      return { reserva: detalle.rows[0], previa, repetido: true };
    }

    if (previa.estado !== "En_Casa") {
      throw new AppError(
        `No se puede hacer check-out de una reserva ${previa.estado.toLowerCase()}. ` +
          "Tiene que estar En_Casa.",
        409
      );
    }

    // Saldo pendiente, en la misma transacción y con la reserva bloqueada.
    const pagado = await client.query(
      `SELECT COALESCE(SUM(monto), 0)::float AS total
       FROM Pago
       WHERE reserva_id = $1 AND estado = 'Confirmado'`,
      [id]
    );
    const totalPagado = Number(pagado.rows[0].total);
    const saldo = Number(((Number(previa.precio_total) - totalPagado) * 100).toFixed(2)) / 100;

    if (saldo > 0 && !forzar) {
      throw new AppError(
        `No se puede cerrar la cuenta: saldo pendiente de $${saldo.toFixed(2)}. ` +
          "Cobralo, o usá forzar_sin_pago si el huésped se va igual.",
        409
      );
    }

    const upd = await client.query(
      `UPDATE Reserva
       SET estado = 'Completada',
           check_out_at = COALESCE(check_out_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND estado = 'En_Casa'
       RETURNING *`,
      [id]
    );

    if (upd.rows.length === 0) {
      throw new AppError(
        "La reserva cambió de estado mientras se procesaba. Reintentá.",
        409
      );
    }

    await client.query(
      "UPDATE Habitacion SET estado_operativo = 'limpieza' WHERE id = $1",
      [previa.habitacion_id]
    );

    const detalle = [
      "Check-out",
      notas || null,
      saldo > 0 ? `Saldo impago: $${saldo.toFixed(2)} (forzado)` : null,
    ]
      .filter(Boolean)
      .join(". ");

    await client.query(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'CheckOut', $2, 'admin', $3)`,
      [id, detalle, ip]
    );

    const detalleReserva = await client.query(SQL_DETALLE, [id]);

    return { reserva: detalleReserva.rows[0], previa, repetido: false, saldo };
  }, ROL.ADMIN);

  if (!resultado.repetido) {
    emitReservaActualizada(resultado.reserva);
  }

  return resultado.reserva;
}

/**
 * "No se presentó" (no-show).
 *
 * Cancelar la reserva y avisarle al huésped. Es la pérdida de plata más directa
 * que tiene el hotel en temporada: una reserva que no se用的是 y que igual
 * bloqueó la habitación para todos los demás (PASOS.md 23.4).
 *
 * Sale del estado En_Casa también, porque el caso real es el del huésped que ya
 * tenía la habitación tomada y a las 23:00 no aparece. Ahí no hay check-in, así
 * que la habitación hay que liberarla a mano con el botón de limpieza.
 */
async function noShow(id, ip) {
  const resultado = await withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT r.id, r.codigo, r.estado, r.precio_total::float,
              c.nombre as cliente_nombre, c.apellido as cliente_apellido,
              c.telefono as cliente_telefono,
              h.numero as habitacion_numero, h.nombre as habitacion_nombre
       FROM Reserva r
       JOIN Cliente c ON c.id = r.cliente_id
       JOIN Habitacion h ON h.id = r.habitacion_id
       WHERE r.id = $1
       FOR UPDATE OF r`,
      [id]
    );

    if (sel.rows.length === 0) {
      throw new AppError("Reserva no encontrada", 404);
    }

    const previa = sel.rows[0];

    if (!["Pendiente", "Confirmada", "En_Casa"].includes(previa.estado)) {
      throw new AppError(
        `Una reserva ${previa.estado.toLowerCase()} no se puede marcar como no presentación`,
        409
      );
    }

    await client.query(
      "UPDATE Reserva SET estado = 'Cancelada', updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Si estaba En_Casa, la habitación quedó con `estado_operativo = 'ocupada'`
    // desde el check-in. Cancelar la reserva sola la dejaba ocupada por siempre:
    // sin huésped, sin check-out, y el botón de "limpieza terminada" rechazando
    // el click porque no estaba en 'limpieza'. Habitación trabada.
    //
    // Va a 'limpieza', no a 'libre', por el mismo motivo del check-out: alguien
    // tiene que revisar esa habitación antes de que vuelva a venderse.
    if (previa.estado === "En_Casa") {
      await client.query(
        "UPDATE Habitacion SET estado_operativo = 'limpieza' WHERE id = $1 AND estado_operativo = 'ocupada'",
        [previa.habitacion_id]
      );

      await client.query(
        `INSERT INTO HistorialHabitacion (habitacion_id, accion, detalle, realizada_por, ip_address)
         VALUES ($1, 'NoShow', $2, 'admin', $3)`,
        [
          previa.habitacion_id,
          `Habitación ${previa.habitacion_numero} liberada por no presentación (${previa.codigo}); pasa a limpieza`,
          ip,
        ]
      );
    }

    await client.query(
      `INSERT INTO HistorialReserva (reserva_id, accion, detalle, realizada_por, ip_address)
       VALUES ($1, 'NoShow', $2, 'admin', $3)`,
      [
        id,
        `El huésped no se presentó. Se da por cancelada la reserva ${previa.codigo}.`,
        ip,
      ]
    );

    const detalle = await client.query(SQL_DETALLE, [id]);

    return { reserva: detalle.rows[0], previa };
  }, ROL.ADMIN);

  emitReservaActualizada(resultado.reserva);

  // Va sin await a propósito, igual que el resto de las notificaciones: el
  // WhatsApp no puede decidir si el no-show queda registrado o no. Si el envío
  // falla, la reserva sigue cancelada y el error se loguea solo.
  notifyNoShow(
    resultado.reserva,
    {
      nombre: resultado.previa.cliente_nombre,
      apellido: resultado.previa.cliente_apellido,
      telefono: resultado.previa.cliente_telefono,
    },
    {
      numero: resultado.previa.habitacion_numero,
      nombre: resultado.previa.habitacion_nombre,
    }
  );

  return resultado.reserva;
}



/**
 * Pantalla "Hoy" para recepción.
 * - Llegadas: Confirmada con fecha_entrada = hoy
 * - En casa: En_Casa
 * - Salidas: En_Casa con fecha_salida = hoy
 */
async function obtenerHoy() {
  const hoy = fechaISO(new Date());

  const result = await executeQuery(
    `SELECT r.id, r.codigo, r.estado, r.origen, r.fecha_entrada, r.fecha_salida,
            r.huespedes, r.precio_total::float, r.notas,
            r.check_in_at, r.check_out_at,
            h.numero AS habitacion_numero, h.nombre AS habitacion_nombre,
            h.estado_operativo,
            c.nombre AS cliente_nombre, c.apellido AS cliente_apellido,
            c.telefono AS cliente_telefono, c.email AS cliente_email,
            COALESCE(p.pagado, 0)::float AS pagado,
            (r.precio_total - COALESCE(p.pagado, 0))::float AS saldo
     FROM Reserva r
     JOIN Habitacion h ON h.id = r.habitacion_id
     JOIN Cliente c ON c.id = r.cliente_id
     LEFT JOIN (
       SELECT reserva_id, SUM(monto) AS pagado
       FROM Pago
       WHERE estado = 'Confirmado'
       GROUP BY reserva_id
     ) p ON p.reserva_id = r.id
     WHERE r.estado IN ('Confirmada', 'En_Casa')
       AND (
         r.fecha_entrada = $1
         OR r.fecha_salida = $1
         OR r.estado = 'En_Casa'
       )
     ORDER BY h.numero, r.fecha_entrada`,
    [hoy],
    ROL.ADMIN
  );

  const filas = result.rows;

  return {
    fecha: hoy,
    llegadas: filas.filter(
      (r) => r.estado === "Confirmada" && fechaISO(r.fecha_entrada) === hoy
    ),
    en_casa: filas.filter((r) => r.estado === "En_Casa"),
    salidas: filas.filter(
      (r) => r.estado === "En_Casa" && fechaISO(r.fecha_salida) === hoy
    ),
    // Los walk-ins van aparte porque recepción los atiende distinto: no vinieron
    // de la web, hay que pedirles documento, y el tiempo que llevan esperando se
    // cuenta desde que entraron, no desde "la fecha de reserva".
    walk_ins: filas.filter(
      (r) => r.origen === "recepcion" && fechaISO(r.fecha_entrada) === hoy
    ),
  };
}
/**
 * Reservas Pendiente donde el huésped avisó "ya transferí"
 * y todavía no hay pago Confirmado.
 */
async function listarPorVerificar({ horasMinimas = 0 } = {}) {
  const result = await executeQuery(
    `SELECT r.id, r.codigo, r.estado, r.fecha_entrada, r.fecha_salida,
            r.huespedes, r.precio_total::float, r.created_at, r.updated_at,
            h.numero AS habitacion_numero, h.nombre AS habitacion_nombre,
            c.nombre AS cliente_nombre, c.apellido AS cliente_apellido,
            c.telefono AS cliente_telefono, c.email AS cliente_email,
            (
              SELECT MAX(hr.created_at)
              FROM HistorialReserva hr
              WHERE hr.reserva_id = r.id AND hr.accion = 'PagoReportado'
            ) AS pago_reportado_at
     FROM Reserva r
     JOIN Habitacion h ON h.id = r.habitacion_id
     JOIN Cliente c ON c.id = r.cliente_id
     WHERE r.estado = 'Pendiente'
       AND EXISTS (
         SELECT 1 FROM HistorialReserva hr
         WHERE hr.reserva_id = r.id AND hr.accion = 'PagoReportado'
       )
       AND NOT EXISTS (
         SELECT 1 FROM Pago p
         WHERE p.reserva_id = r.id AND p.estado = 'Confirmado'
       )
       AND (
         $1::int <= 0
         OR EXISTS (
           SELECT 1 FROM HistorialReserva hr2
           WHERE hr2.reserva_id = r.id
             AND hr2.accion = 'PagoReportado'
             AND hr2.created_at <= NOW() - ($1 || ' hours')::interval
         )
       )
     ORDER BY pago_reportado_at ASC NULLS LAST`,
    [String(horasMinimas)],
    ROL.ADMIN
  );

  return result.rows;
}
module.exports = {
  consultarPorCodigo,
  cancelarPorHuesped,
  reportarPagoPorHuesped,
  crear,
  obtenerPorId,
  listar,
  cambiarEstado,
  obtenerContacto,
  puedeCancelar,
  horasHastaEntrada,
  fechaISO,
  nochesEntre,
  HORAS_CANCELACION,
  checkIn,
  checkOut,
  noShow,
  obtenerHoy,
  crearWalkIn,
  listarPorVerificar,
};
