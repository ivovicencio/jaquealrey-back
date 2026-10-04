-- Recepción: estado En_Casa, check-in/out, estado operativo de la habitación y
-- datos de identidad del huésped.
--
-- Es idempotente de punta a punta: se puede correr las veces que haga falta.
-- Todas las columnas van con ADD COLUMN IF NOT EXISTS y todas las constraints
-- se crean desde un DO $$ que primero pregunta pg_constraint, porque `ADD COLUMN
-- IF NOT EXISTS` se salta la columna entera si ya existe y las constraints que
-- vienen en la misma sentencia se irían con ella.
--
-- Ver también db/init.sql, que tiene el esquema destino. Este archivo es el
-- camino para llegar ahí desde una base que ya existe.


-- ===========================================================================
-- 0. El conjunto de estados que ocupan la habitación, en un solo lugar
-- ===========================================================================
--
-- Todo estado de reserva que "ocupa" la habitación tiene que estar en esta
-- lista. El día que aparezca un estado nuevo ( medio pago, bloqueada ) y no se
-- agregue acá, la habitación vuelve a estar vendible y se sobrevende.
--
-- IMMUTABLE es obligatorio: la usan índices y constraints, y Postgres rechaza
-- cualquier cosa que no lo sea en el predicado de un índice.
CREATE OR REPLACE FUNCTION reserva_ocupa_habitacion(p_estado TEXT)
RETURNS BOOLEAN AS $$
    SELECT p_estado IN ('Pendiente', 'Confirmada', 'En_Casa');
$$ LANGUAGE sql IMMUTABLE;


-- ===========================================================================
-- 1. Permitir el estado En_Casa
-- ===========================================================================
--
-- El CHECK de init.sql viene con nombre automático (reserva_estado_check), así
-- que no se puede DROP CONSTRAINT por nombre: hay que buscarlo por definición.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'Reserva'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%estado%'
  LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE Reserva DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE Reserva DROP CONSTRAINT IF EXISTS reserva_estado_valido;

ALTER TABLE Reserva
  ADD CONSTRAINT reserva_estado_valido
  CHECK (estado IN ('Pendiente', 'Confirmada', 'En_Casa', 'Cancelada', 'Completada'));

-- ===========================================================================
-- 2. El hecho del check-in, separado del estado
-- ===========================================================================
--
-- `estado` responde "en qué etapa está la reserva". Estas columnas responden
-- "cuándo pasó". Son cosas distintas: una reserva se puede poner Completada
-- desde la reserva sin pasar por recepción (cierre administrativo), y ahí
-- check_out_at queda en null a propósito. Rellenar el timestamp a mano para que
-- "cuadre" convierte el dato en mentira.
ALTER TABLE Reserva ADD COLUMN IF NOT EXISTS origen VARCHAR(20);
ALTER TABLE Reserva ADD COLUMN IF NOT EXISTS check_in_at TIMESTAMPTZ;
ALTER TABLE Reserva ADD COLUMN IF NOT EXISTS check_out_at TIMESTAMPTZ;
ALTER TABLE Reserva ADD COLUMN IF NOT EXISTS entregado_a VARCHAR(150);

UPDATE Reserva SET origen = 'public' WHERE origen IS NULL;

ALTER TABLE Reserva ALTER COLUMN origen SET NOT NULL;

-- El DEFAULT se pone DESPUÉS del backfill, y no en el ADD COLUMN, por una
-- razón práctica: si el default estuviera en el ADD COLUMN, `ADD COLUMN IF NOT
-- EXISTS` lo saltearía en las bases que ya tienen la columna, y ahí la columna
-- queda NOT NULL sin default. Desde ese momento, todo INSERT que no mencione
-- `origen` revienta con un not-null violation, que es exactamente lo que hace
-- el resto del código que no conoce esta columna.
ALTER TABLE Reserva ALTER COLUMN origen SET DEFAULT 'public';

ALTER TABLE Reserva DROP CONSTRAINT IF EXISTS reserva_origen_valido;
ALTER TABLE Reserva
  ADD CONSTRAINT reserva_origen_valido CHECK (origen IN ('public', 'recepcion'));

-- check_out_at sin check_in_at es imposible, pero al revés sí: una reserva puede
-- quedar En_Casa sin timestamp si se importó de ahi.
ALTER TABLE Reserva DROP CONSTRAINT IF EXISTS reserva_checkout_con_checkin;
ALTER TABLE Reserva
  ADD CONSTRAINT reserva_checkout_con_checkin
  CHECK (check_out_at IS NULL OR check_in_at IS NOT NULL);


-- ===========================================================================
-- 3. Estado operativo de la habitación
-- ===========================================================================
--
-- `activa = false` es "esta habitación no existe más para el hotel".
-- `estado_operativo` es "esta habitación existe pero hoy no se puede vender":
-- la está limpiando alguien, o se rompió el aire. Una habitación en limpieza NO
-- es una habitación libre: es la que el huésped de la noche siguiente espera.
ALTER TABLE Habitacion ADD COLUMN IF NOT EXISTS estado_operativo VARCHAR(20);

UPDATE Habitacion SET estado_operativo = 'libre' WHERE estado_operativo IS NULL;

ALTER TABLE Habitacion ALTER COLUMN estado_operativo SET NOT NULL;

-- Mismo caso que `origen`: el default va aparte, o el IF NOT EXISTS lo saltea
-- y la columna queda NOT NULL sin default. Sin esto, crear una habitación desde
-- el panel falla.
ALTER TABLE Habitacion ALTER COLUMN estado_operativo SET DEFAULT 'libre';

ALTER TABLE Habitacion DROP CONSTRAINT IF EXISTS habitacion_estado_op_valido;
ALTER TABLE Habitacion
  ADD CONSTRAINT habitacion_estado_op_valido
  CHECK (estado_operativo IN ('libre', 'ocupada', 'limpieza', 'mantenimiento'));


-- ===========================================================================
-- 4. Bloqueo por rango de fechas
-- ===========================================================================
--
-- Para sacar una habitación del mercado un fin de semana y venderla el lunes.
-- `activa = false` no sirve para eso: es permanente.
CREATE TABLE IF NOT EXISTS HabitacionBloqueo (
    id SERIAL PRIMARY KEY,
    habitacion_id INTEGER NOT NULL REFERENCES Habitacion(id) ON DELETE CASCADE,
    desde DATE NOT NULL,
    hasta DATE NOT NULL,
    motivo VARCHAR(200) NOT NULL,
    creado_por VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bloqueo_rango_valido CHECK (hasta > desde)
);

CREATE INDEX IF NOT EXISTS idx_bloqueo_hab
    ON HabitacionBloqueo(habitacion_id, desde, hasta);

CREATE INDEX IF NOT EXISTS idx_bloqueo_rango ON HabitacionBloqueo(desde, hasta);


-- ===========================================================================
-- 5. Identidad del huésped
-- ===========================================================================
--
-- Registro Nacional de Alojamientos. Ver PASOS.md fase 4: sin esto el hotel no
-- puede responder "¿quién se hospedó el 12?", que es un problema legal, no de
-- comfortable.
ALTER TABLE Cliente ADD COLUMN IF NOT EXISTS documento VARCHAR(30);
ALTER TABLE Cliente ADD COLUMN IF NOT EXISTS nacionalidad VARCHAR(60);
ALTER TABLE Cliente ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE;

-- Timestamp y no boolean. "Datos verificados = true" no dice CUANDO se
-- verificaron ni quién lo hizo, y para responder por un huésped lo que importa
-- es la fecha: un documento verificado en 2024 bajo otra gestión puede no servir
-- en 2026. Con el timestamp, un NULL dice "autodeclarado" y un valor dice
-- "recepción lo vio en este momento", que es la diferencia que importa cuando
-- hay que responder por algo (PASOS.md 24.3).
ALTER TABLE Cliente ADD COLUMN IF NOT EXISTS verificado_en TIMESTAMPTZ;


-- ===========================================================================
-- 6. Consentimiento versionado
-- ===========================================================================
--
-- El snapshot del texto, no solo la fecha. Si el documento se reescribe, hace
-- falta poder probar qué aceptó cada huésped, no que aceptó "algo".
CREATE TABLE IF NOT EXISTS Consentimiento (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER REFERENCES Cliente(id) ON DELETE SET NULL,
    reserva_id INTEGER REFERENCES Reserva(id) ON DELETE SET NULL,
    documento VARCHAR(80) NOT NULL,
    version VARCHAR(20) NOT NULL,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Tiene que estar ligado a alguien: un registro huérfano no prueba nada.
    CONSTRAINT consentimiento_alguien CHECK (cliente_id IS NOT NULL OR reserva_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_consentimiento_cliente ON Consentimiento(cliente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consentimiento_reserva ON Consentimiento(reserva_id);


-- ===========================================================================
-- 7. Bitácora de habitaciones
-- ===========================================================================
--
-- HistorialReserva está atada por FK a Reserva, así que no hay dónde registrar
-- que alguien cambió el precio de la 7, la desactivó, o la pasó a
-- mantenimiento. Y esas son exactamente las decisiones que se discuten cuando
-- un huésped reclama por lo que le cobraron.
CREATE TABLE IF NOT EXISTS HistorialHabitacion (
    id SERIAL PRIMARY KEY,
    -- Nullable a proposito. Con NOT NULL + ON DELETE CASCADE, borrar una
    -- habitación se llevaba su propia bitácora, y el registro de por qué se dio
    -- de baja era justo el que más importaba conservar. Con SET NULL la fila
    -- sobrevive y dice "la habitación 12 ya no existe".
    habitacion_id INTEGER REFERENCES Habitacion(id) ON DELETE SET NULL,
    accion VARCHAR(50) NOT NULL,
    detalle TEXT,
    -- 'admin' | 'sistema' | 'huesped'. Texto y no FK a Usuario: la bitácora
    -- tiene que seguir siendo legible aunque el usuario se borre del sistema.
    -- Ojo: esto la vuelve PII si se guarda el nombre. Por eso se guarda el rol y
    -- no el id del usuario.
    realizada_por VARCHAR(50) NOT NULL DEFAULT 'admin',
    ip_address VARCHAR(45),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Idempotente para las instalaciones donde la tabla ya existía con el
-- NOT NULL / CASCADE originales.
ALTER TABLE HistorialHabitacion
    ALTER COLUMN habitacion_id DROP NOT NULL;

ALTER TABLE HistorialHabitacion
    DROP CONSTRAINT IF EXISTS historial_habitacion_id_fkey;

ALTER TABLE HistorialHabitacion
    ADD CONSTRAINT historial_habitacion_id_fkey
    FOREIGN KEY (habitacion_id) REFERENCES Habitacion(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_historial_hab ON HistorialHabitacion(habitacion_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_historial_hab_borrada ON HistorialHabitacion(created_at DESC)
    WHERE habitacion_id IS NULL;

-- La bitácora es de consulta: no se modifica ni se borra.
ALTER TABLE HistorialHabitacion ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS historial_hab_select_admin ON HistorialHabitacion;
CREATE POLICY historial_hab_select_admin ON HistorialHabitacion FOR SELECT
    USING (current_setting('app.role', true) = 'admin');

DROP POLICY IF EXISTS historial_hab_insert_admin ON HistorialHabitacion;
CREATE POLICY historial_hab_insert_admin ON HistorialHabitacion FOR INSERT
    WITH CHECK (current_setting('app.role', true) = 'admin');


-- ===========================================================================
-- 8. Que En_Casa también ocupe la habitación (anti-sobreventa)
-- ===========================================================================
--
-- OJO con el predicado de acá. Es la ÚNICA cosa que impide vender dos veces la
-- misma habitación, así que la lista de estados va escrita literal y no usando
-- reserva_ocupa_habitacion().
--
-- La tentación es usar la función para no duplicar la lista. El problema es que
-- un predicado de índice NO se recalcula cuando cambia el cuerpo de la función:
-- alguien agrega 'Bloqueada' a reserva_ocupa_habitacion, todo el resto del
-- sistema empieza a tratar esa reserva como ocupante, y esta constraint sigue
-- como estaba, en silencio, vendiendo la habitación otra vez. Sin error, sin
-- log, sin nada. Duplicar la lista esVisible: si se desincroniza, el INSERT
-- revienta con 23P01 y se ve al toque.
--
-- Si se cambia la lista, hay que volver a correr los bloques 7 y 8 juntos.
ALTER TABLE Reserva DROP CONSTRAINT IF EXISTS reserva_sin_solapamiento;

ALTER TABLE Reserva ADD CONSTRAINT reserva_sin_solapamiento
  EXCLUDE USING gist (
    habitacion_id WITH =,
    daterange(fecha_entrada, fecha_salida, '[)') WITH &&
  )
  WHERE (estado IN ('Pendiente', 'Confirmada', 'En_Casa'));

-- El índice parcial tiene que traer exactamente el mismo predicado que la
-- constraint. Con el predicado viejo (sin En_Casa) Postgres no puede usar el
-- índice para verificar la constraint y la sobreventa se evita, pero
-- escaneando el GIST entero en cada intento de reserva.
DROP INDEX IF EXISTS idx_reserva_fechas_exclusion;

CREATE INDEX idx_reserva_fechas_exclusion
    ON Reserva USING gist (
        habitacion_id,
        daterange(fecha_entrada, fecha_salida, '[)')
    ) WHERE estado IN ('Pendiente', 'Confirmada', 'En_Casa');


-- ===========================================================================
-- 9. Disponibilidad, ahora con estado operativo y bloqueos
-- ===========================================================================
--
-- Las dos functions son SECURITY DEFINER porque las llama el alta pública de
-- reservas: sin eso el RLS filtraría el SELECT y la función no vería las
-- reservas de otros. NO SACAR EL SECURITY DEFINER.
--
-- Sí usan reserva_ocupa_habitacion(): acá sí conviene, porque un desajuste se
-- nota (la habitación aparece disponible y el INSERT falla con 23P01) en vez
-- de producir una sobreventa silenciosa.
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

    -- Bloqueo manual por rango.
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
      -- 'ocupada' se acepta: la habitacion con un huésped adentro tiene que
      -- seguir apareciendo como candidata para la NOCHE SIGUIENTE, cuando ya se
      -- fue. Lo que la saca del mercado es el solapamiento de reservas, que se
      -- chequea abajo. 'limpieza' y 'mantenimiento' si la sacan.
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


-- ===========================================================================
-- 10. RLS de las tablas nuevas
-- ===========================================================================
--
-- Sin esto las tablas nuevas quedan con el comportamiento por defecto de
-- Postgres, que es permitir todo al que tenga permiso. Y el permiso lo da
-- security.sql (que corre después) en bloque a jaquealrey_app. O sea: sin RLS,
-- cualquier endpoint que llegue a tocar Consentimiento lee los consentimientos
-- de todos los huéspedes, y cualquiera puede borrar un bloqueo de habitación.
--
-- Nota sobre disponibilidad: las functions de disponibilidad son SECURITY
-- DEFINER, asi que leen HabitacionBloqueo saltandose estas politicas. Eso es lo
-- correcto: el endpoint publico tiene que poder excluir una habitación
-- bloqueada sin poder ver la lista de bloqueos ni los motivos.
ALTER TABLE HabitacionBloqueo ENABLE ROW LEVEL SECURITY;
ALTER TABLE Consentimiento ENABLE ROW LEVEL SECURITY;
-- El SELECT publico existe solo para que la function de disponibilidad, que es
-- SECURITY DEFINER, pueda excluir una habitacion bloqueada. El endpoint publico
-- nunca lista los bloqueos directamente: los motivos son internos del hotel.
DROP POLICY IF EXISTS bloqueo_select_public ON HabitacionBloqueo;
CREATE POLICY bloqueo_select_public ON HabitacionBloqueo FOR SELECT USING (true);

DROP POLICY IF EXISTS bloqueo_write_admin ON HabitacionBloqueo;
CREATE POLICY bloqueo_write_admin ON HabitacionBloqueo FOR ALL
    USING (current_setting('app.role', true) = 'admin')
    WITH CHECK (current_setting('app.role', true) = 'admin');

-- Consentimiento es de solo lectura para el admin y de solo insercion: es un
-- registro legal, no algo que se pueda corregir. Un DELETE aca borraria la
-- prueba de que el huésped aceptó los terminos.
DROP POLICY IF EXISTS consentimiento_select_admin ON Consentimiento;
CREATE POLICY consentimiento_select_admin ON Consentimiento FOR SELECT
    USING (current_setting('app.role', true) = 'admin');

DROP POLICY IF EXISTS consentimiento_insert ON Consentimiento;
CREATE POLICY consentimiento_insert ON Consentimiento FOR INSERT WITH CHECK (true);
