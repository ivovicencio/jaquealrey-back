-- ============================================================
-- Hotel Jaque al Rey - Esquema Completo + Tuning
-- ============================================================

-- ============================================================
-- TUNING: Configuración para 1000+ usuarios concurrentes
-- Ejecutar como superusario si es necesario
-- ============================================================
-- NOTA: Estos valores ya están seteados en docker-compose.yml
-- via command: postgres -c max_connections=200 -c ...
-- Si usás Supabase, estos params los maneja ellos.
-- Para Docker local / Railway, están cubiertos.
--
-- Parámetros clave para alta concurrencia:
--   max_connections = 200
--   shared_buffers = 256MB      (25% de RAM disponible)
--   effective_cache_size = 768MB (75% de RAM disponible)
--   work_mem = 8MB              (256MB / (max_connections / 16))
--   maintenance_work_mem = 64MB
--   wal_buffers = 16MB
--   checkpoint_completion_target = 0.9
--   random_page_cost = 1.1      (SSD)
--   effective_io_concurrency = 200 (SSD)
--   max_worker_processes = 8
--   max_parallel_workers_per_gather = 4
--   max_parallel_workers = 8
--   max_parallel_maintenance_workers = 4
-- ============================================================

-- ============================================================
-- Crear extensión para UUID (generación de códigos)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- Tabla: Hotel (info del hotel, una sola fila)
-- ============================================================
-- ============================================================
-- Hotel Jaque al Rey - Esquema Completo + Tuning
-- ============================================================
-- ... (mantener el resto igual hasta la tabla Hotel) ...
CREATE TABLE Hotel (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL DEFAULT 'Jaque al Rey',
    direccion VARCHAR(255) NOT NULL,
    telefono VARCHAR(20) NOT NULL,
    email VARCHAR(150),
    descripcion TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT hotel_tabla_unica CHECK (id = 1)
);

-- ============================================================
-- Tabla: Habitacion
-- ============================================================
CREATE TABLE Habitacion (
    id SERIAL PRIMARY KEY,
    numero SMALLINT NOT NULL UNIQUE CHECK (numero > 0),
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    camas_individuales SMALLINT NOT NULL DEFAULT 0 CHECK (camas_individuales >= 0),
    camas_matrimoniales SMALLINT NOT NULL DEFAULT 0 CHECK (camas_matrimoniales >= 0),
    capacidad_max SMALLINT NOT NULL CHECK (capacidad_max > 0),
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('Doble', 'Triple', 'Cuádruple')),
    precio_noche DECIMAL(10, 2) NOT NULL CHECK (precio_noche > 0),
    activa BOOLEAN NOT NULL DEFAULT true,
    -- Estado operativo, que es distinto de `activa`: `activa = false` es "esta
    -- habitacion no existe mas para el hotel", `estado_operativo` es "existe pero
    -- hoy no se puede vender" (la estan limpiando, o se rompio el aire).
    estado_operativo VARCHAR(20) NOT NULL DEFAULT 'libre'
        CHECK (estado_operativo IN ('libre', 'ocupada', 'limpieza', 'mantenimiento')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Tabla: HabitacionBloqueo
-- ============================================================
-- Sacar una habitacion del mercado un rango de fechas y venderla despues.
-- `activa = false` no sirve para eso: es permanente.
CREATE TABLE HabitacionBloqueo (
    id SERIAL PRIMARY KEY,
    habitacion_id INTEGER NOT NULL REFERENCES Habitacion(id) ON DELETE CASCADE,
    desde DATE NOT NULL,
    hasta DATE NOT NULL,
    motivo VARCHAR(200) NOT NULL,
    creado_por VARCHAR(150),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (hasta > desde)
);

CREATE INDEX idx_bloqueo_hab ON HabitacionBloqueo(habitacion_id, desde, hasta);
CREATE INDEX idx_bloqueo_rango ON HabitacionBloqueo(desde, hasta);

-- ============================================================
-- Tabla: Cliente
-- ============================================================
CREATE TABLE Cliente (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    apellido VARCHAR(100) NOT NULL DEFAULT '',
    telefono VARCHAR(20) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    -- Identidad, exigida por el Registro Nacional de Alojamientos. Es NULL en
    -- los clientes que se crearon por el formulario web: pedir DNI a alguien
    -- parado en la ruta a las 23:00 cuesta la reserva y no hace falta para
    -- reservar. Se completa en el check-in.
    documento VARCHAR(30),
    nacionalidad VARCHAR(60),
    fecha_nacimiento DATE,
    -- Timestamp y no boolean: dice cuándo lo verificó recepción, que es lo que
    -- sirve para responder por un huésped. NULL = autodeclarado en la web.
    verificado_en TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Tabla: Reserva
-- ============================================================
CREATE TABLE Reserva (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(12) UNIQUE NOT NULL,
    cliente_id INTEGER NOT NULL REFERENCES Cliente(id) ON DELETE CASCADE,
    habitacion_id INTEGER NOT NULL REFERENCES Habitacion(id) ON DELETE RESTRICT,
    fecha_entrada DATE NOT NULL,
    fecha_salida DATE NOT NULL,
    huespedes SMALLINT NOT NULL CHECK (huespedes > 0),
    precio_total DECIMAL(10, 2) NOT NULL CHECK (precio_total > 0),
    estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente'
        CHECK (estado IN ('Pendiente', 'Confirmada', 'En_Casa', 'Cancelada', 'Completada')),
    -- De donde salio la reserva. 'recepcion' es un walk-in: el huesped esta
    -- parado en el mostrador y no publico nada desde la web.
    origen VARCHAR(20) NOT NULL DEFAULT 'public'
        CHECK (origen IN ('public', 'recepcion')),
    -- Los hechos del check-in, que no son lo mismo que el estado. Una reserva
    -- puede pasar a Completada desde la reserva (cierre administrativo) y ahi
    -- check_out_at queda en NULL a proposito.
    check_in_at TIMESTAMPTZ,
    check_out_at TIMESTAMPTZ,
    entregado_a VARCHAR(150),
    notas TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CHECK (fecha_salida > fecha_entrada),
    CHECK (check_out_at IS NULL OR check_in_at IS NOT NULL)
);

-- ============================================================
-- Tabla: Consentimiento
-- ============================================================
-- Snapshot del texto aceptado, no solo la fecha. Si el documento se reescribe,
-- hace falta poder probar qué leyo cada huesped.
--
-- Va despues de Reserva a proposito: la clave foranea lo necesita.
CREATE TABLE Consentimiento (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER REFERENCES Cliente(id) ON DELETE SET NULL,
    reserva_id INTEGER REFERENCES Reserva(id) ON DELETE SET NULL,
    documento VARCHAR(80) NOT NULL,
    version VARCHAR(20) NOT NULL,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Un registro sin cliente ni reserva no prueba nada.
    CHECK (cliente_id IS NOT NULL OR reserva_id IS NOT NULL)
);

CREATE INDEX idx_consentimiento_cliente ON Consentimiento(cliente_id, created_at DESC);
CREATE INDEX idx_consentimiento_reserva ON Consentimiento(reserva_id);

-- ============================================================
-- Tabla: HistorialReserva (log inmutable)
-- ============================================================
CREATE TABLE HistorialReserva (
    id SERIAL PRIMARY KEY,
    reserva_id INTEGER NOT NULL REFERENCES Reserva(id) ON DELETE CASCADE,
    accion VARCHAR(50) NOT NULL,
    detalle TEXT,
    realizada_por VARCHAR(50) NOT NULL DEFAULT 'cliente',
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Tabla: HistorialHabitacion (log inmutable)
-- ============================================================
-- El gemelo del HistorialReserva, para la habitación. Sin esto, el estado
-- operativo era un entero sin explicación: nadie podía responder "¿por qué la 12
-- está en mantenimiento desde el martes?" ni "¿quién cambió el precio a la
-- mañana?".
--
-- OJO: es distinto del HistorialReserva en que `habitacion_id` es nullable con
-- ON DELETE SET NULL. Con NOT NULL + CASCADE, borrar una habitación se llevaba su
-- propia bitácora, o sea que se perdía el registro de por qué se dio de baja.
CREATE TABLE HistorialHabitacion (
    id SERIAL PRIMARY KEY,
    habitacion_id INTEGER REFERENCES Habitacion(id) ON DELETE SET NULL,
    accion VARCHAR(50) NOT NULL,
    detalle TEXT,
    -- 'admin' | 'sistema'. Texto y no FK a Usuario a propósito: la bitácora tiene
    -- que seguir siendo legible aunque el usuario se borre. Y guardar el rol en
    -- vez del id evita meter PII de empleados en una tabla de auditoría.
    realizada_por VARCHAR(50) NOT NULL DEFAULT 'admin',
    ip_address VARCHAR(45),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_historial_hab ON HistorialHabitacion(habitacion_id, created_at DESC);
-- Índice aparte para los borrados (hist habitacion_id IS NULL): son pocos, pero
-- la consulta "qué habitaciones se dieron de baja" es la que más se consulta en
-- una auditoría y sin este índice tiene que recorrer toda la bitácora.
CREATE INDEX idx_historial_hab_borrada ON HistorialHabitacion(created_at DESC)
    WHERE habitacion_id IS NULL;

-- ============================================================
-- ÍNDICES OPTIMIZADOS
-- ============================================================
-- Habitacion: búsqueda por tipo y activas
CREATE INDEX idx_habitacion_tipo ON Habitacion(tipo);
CREATE INDEX idx_habitacion_activa ON Habitacion(activa);
CREATE INDEX idx_habitacion_tipo_activa ON Habitacion(tipo, activa) WHERE activa = true;

-- Cliente: búsqueda por email (único)
CREATE UNIQUE INDEX idx_cliente_email ON Cliente(LOWER(email));

-- Reserva: índices compuestos para queries frecuentes
CREATE INDEX idx_reserva_cliente ON Reserva(cliente_id);
CREATE INDEX idx_reserva_habitacion ON Reserva(habitacion_id);
CREATE UNIQUE INDEX idx_reserva_codigo ON Reserva(codigo);

-- Índice GIST para solapamiento de fechas (optimiza OVERLAPS)
--
-- El predicado tiene que traer EXACTAMENTE los mismos estados que la
-- constraint EXCLUDE `reserva_sin_solapamiento` de db/security.sql. Si el
-- índice deja afuera un estado que la constraint incluye, la constraint sigue
-- siendo correcta (no hay sobreventa) pero cada intento de reserva tiene que
-- recorrer el GIST entero para verificarla.
CREATE INDEX idx_reserva_fechas_exclusion
    ON Reserva USING gist (
        habitacion_id,
        daterange(fecha_entrada, fecha_salida, '[)')
    ) WHERE estado IN ('Pendiente', 'Confirmada', 'En_Casa');

-- Índice B-tree complementario para ordenamiento
CREATE INDEX idx_reserva_fechas ON Reserva(fecha_entrada, fecha_salida);
CREATE INDEX idx_reserva_estado ON Reserva(estado);
CREATE INDEX idx_reserva_fechas_estado ON Reserva(estado, fecha_entrada, fecha_salida);

-- HistorialReserva: búsqueda por reserva y fecha
CREATE INDEX idx_historial_reserva ON HistorialReserva(reserva_id);
CREATE INDEX idx_historial_fecha ON HistorialReserva(created_at DESC);

-- ============================================================
-- FUNCIÓN: reserva_ocupa_habitacion (única fuente de verdad)
--
-- Todo estado de reserva que ocupa la habitación tiene que estar en esta lista.
-- El día que aparezca un estado nuevo y no se agregue acá, la habitación vuelve
-- a estar vendible y se sobrevende.
--
-- IMMUTABLE es obligatorio: la usan las funciones de disponibilidad y los
-- predicados de índice, y Postgres rechaza en un índice cualquier cosa que no
-- lo sea.
--
-- OJO: la constraint EXCLUDE `reserva_sin_solapamiento` (db/security.sql) NO
-- usa esta función, escribe la lista literal. Un predicado de índice no se
-- recalcula cuando cambia el cuerpo de una función, así que si alguien agrega
-- un estado acá y olvida la constraint, la sobreventa vuelve en silencio.
-- Duplicar la lista ahí es lo seguro: el desajuste se ve como un 23P01.
-- Ver el comentario largo en db/recepcion.sql, bloque 7.
-- ============================================================
CREATE OR REPLACE FUNCTION reserva_ocupa_habitacion(p_estado TEXT)
RETURNS BOOLEAN AS $$
    SELECT p_estado IN ('Pendiente', 'Confirmada', 'En_Casa');
$$ LANGUAGE sql IMMUTABLE;

-- ============================================================
-- FUNCIÓN: habitacion_disponible (optimizada con índice GIST)
--
-- POR QUÉ ES SECURITY DEFINER -- NO SACARLO
--
-- Esta función se llama desde el alta de reservas con ROL.PUBLICO, o sea que
-- corre como un usuario que no es el dueño de la tabla Reserva. Sin
-- SECURITY DEFINER el SELECT interno sobre Reserva pasa por las políticas de
-- RLS, y la única política de SELECT de Reserva (reserva_select_self, en
-- rls.sql) exige ser el dueño de la reserva o admin. Con ROL.PUBLICO ninguna
-- de las dos se cumple, RLS devuelve CERO filas, el NOT EXISTS da TRUE siempre
-- y la función responde "disponible" para absolutamente cualquier habitación.
--
-- O sea: sin esto el filtro de disponibilidad es decorativo. El huésped ve la
-- 7 ocupada en el listado, la elige, llena el formulario entero y recién en el
-- INSERT se lleva un 409 de la constraint reserva_sin_solapamiento. La
-- sobreventa no se evitaba, se mudaba de momento.
--
-- Con SECURITY DEFINER el SELECT corre como el dueño de la función, y ahí RLS
-- no filtra. OJO: esto depende de que ese dueño pueda saltarse RLS. Reserva
-- tiene FORCE ROW LEVEL SECURITY (security.sql), que ata RLS incluso al dueño
-- de la tabla, así que si el dueño de la función fuera un rol común el fix
-- seguiría sin hacer nada y nadie vería un error. Por eso las migraciones
-- tienen que correr con DATABASE_ADMIN_URL (superusuario), nunca con
-- DATABASE_URL. Para verificarlo:
--
--   SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, r.rolsuper, r.rolbypassrls
--     FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
--    WHERE p.proname IN ('habitacion_disponible','habitaciones_disponibles_en_rango');
--
-- owner tiene que ser un rol con rolsuper = t o rolbypassrls = t.
--
-- El SET search_path va fijo por seguridad: sin él, quien pueda crear objetos
-- en un esquema anterior del path podría interceptar la resolución de nombres
-- y hacer que la función lea otra tabla.
-- ============================================================
CREATE OR REPLACE FUNCTION habitacion_disponible(
    p_habitacion_id INTEGER,
    p_fecha_entrada DATE,
    p_fecha_salida DATE,
    p_excluir_reserva_id INTEGER DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
    v_estado_op TEXT;
BEGIN
    SELECT estado_operativo INTO v_estado_op
    FROM Habitacion
    WHERE id = p_habitacion_id AND activa = true;

    -- No existe, o esta fuera de servicio: no se puede reservar.
    IF v_estado_op IS NULL OR v_estado_op = 'mantenimiento' THEN
        RETURN false;
    END IF;

    -- Bloqueo manual por rango de fechas.
    IF EXISTS (
        SELECT 1 FROM HabitacionBloqueo b
        WHERE b.habitacion_id = p_habitacion_id
          AND daterange(b.desde, b.hasta, '[)') &&
              daterange(p_fecha_entrada, p_fecha_salida, '[)')
    ) THEN
        RETURN false;
    END IF;

    RETURN NOT EXISTS (
        SELECT 1 FROM Reserva
        WHERE habitacion_id = p_habitacion_id
          AND reserva_ocupa_habitacion(estado)
          AND (p_excluir_reserva_id IS NULL OR id != p_excluir_reserva_id)
          AND daterange(fecha_entrada, fecha_salida, '[)') &&
              daterange(p_fecha_entrada, p_fecha_salida, '[)')
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- FUNCIÓN: habitaciones_disponibles_en_rango (optimizada)
-- Devuelve IDs de habitaciones disponibles en un rango
--
-- POR QUÉ ES SECURITY DEFINER -- NO SACARLO
--
-- Mismo motivo que habitacion_disponible, y el mismo bug si se le saca: se
-- llama desde el catálogo y desde "Buscar disponibilidad" con ROL.PUBLICO, y
-- su NOT EXISTS sobre Reserva sin SECURITY DEFINER devuelve siempre cero
-- filas, o sea que devuelve TODAS las habitaciones activas como disponibles.
-- Esta es la función que alimenta el listado que mira el huésped antes de
-- reservar, así que cuando fallaba el fallo se veía literal: ofreciendo
-- habitaciones ya ocupadas.
--
-- SECURITY DEFINER + search_path fijo: ver la nota larga arriba, en
-- habitacion_disponible. Es el mismo requisito de owner con BYPASSRLS.
-- ============================================================
CREATE OR REPLACE FUNCTION habitaciones_disponibles_en_rango(
    p_fecha_entrada DATE,
    p_fecha_salida DATE,
    p_excluir_reserva_id INTEGER DEFAULT NULL
) RETURNS TABLE(habitacion_id INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT h.id
    FROM Habitacion h
    WHERE h.activa = true
      -- 'ocupada' se acepta a proposito: una habitacion con un huesped adentro
      -- tiene que seguir apareciendo como candidata para la NOCHE SIGUIENTE,
      -- cuando ya se fue. Lo que la saca del mercado es el solapamiento de
      -- reservas, que se chequea abajo. 'limpieza' y 'mantenimiento' si la
      -- sacan: una habitacion sin limpiar no es una habitacion libre.
      AND h.estado_operativo IN ('libre', 'ocupada')
      AND NOT EXISTS (
          SELECT 1 FROM HabitacionBloqueo b
          WHERE b.habitacion_id = h.id
            AND daterange(b.desde, b.hasta, '[)') &&
                daterange(p_fecha_entrada, p_fecha_salida, '[)')
      )
      AND NOT EXISTS (
          SELECT 1 FROM Reserva r
          WHERE r.habitacion_id = h.id
            AND reserva_ocupa_habitacion(r.estado)
            AND (p_excluir_reserva_id IS NULL OR r.id != p_excluir_reserva_id)
            AND daterange(r.fecha_entrada, r.fecha_salida, '[)') &&
                daterange(p_fecha_entrada, p_fecha_salida, '[)')
      )
    ORDER BY h.numero;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- FUNCIÓN: buscar_cliente_por_email (bypass RLS con SECURITY DEFINER)
-- Necesaria porque RLS bloquea SELECT público en Cliente
-- ============================================================
CREATE OR REPLACE FUNCTION buscar_cliente_por_email(p_email TEXT)
RETURNS TABLE(id INTEGER, nombre VARCHAR, apellido VARCHAR, telefono VARCHAR, email VARCHAR, password VARCHAR, created_at TIMESTAMP)
SECURITY DEFINER
AS $$
  SELECT id, nombre, apellido, telefono, email, password, created_at
  FROM Cliente
  WHERE LOWER(email) = LOWER(p_email)
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- TRIGGER: actualizar updated_at en Reserva
-- ============================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON Reserva
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
