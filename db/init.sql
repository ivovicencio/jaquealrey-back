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
CREATE TABLE Hotel (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL DEFAULT 'Jaque al Rey',
    direccion VARCHAR(255) NOT NULL,
    telefono VARCHAR(20) NOT NULL,
    email VARCHAR(150),
    descripcion TEXT,
    created_at TIMESTAMP DEFAULT NOW()
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
    created_at TIMESTAMP DEFAULT NOW()
);

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
        CHECK (estado IN ('Pendiente', 'Confirmada', 'Cancelada', 'Completada')),
    notas TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CHECK (fecha_salida > fecha_entrada)
);

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
CREATE INDEX idx_reserva_fechas_exclusion
    ON Reserva USING gist (
        habitacion_id,
        daterange(fecha_entrada, fecha_salida, '[)')
    ) WHERE estado IN ('Pendiente', 'Confirmada');

-- Índice B-tree complementario para ordenamiento
CREATE INDEX idx_reserva_fechas ON Reserva(fecha_entrada, fecha_salida);
CREATE INDEX idx_reserva_estado ON Reserva(estado);
CREATE INDEX idx_reserva_fechas_estado ON Reserva(estado, fecha_entrada, fecha_salida);

-- HistorialReserva: búsqueda por reserva y fecha
CREATE INDEX idx_historial_reserva ON HistorialReserva(reserva_id);
CREATE INDEX idx_historial_fecha ON HistorialReserva(created_at DESC);

-- ============================================================
-- FUNCIÓN: habitacion_disponible (optimizada con índice GIST)
-- ============================================================
CREATE OR REPLACE FUNCTION habitacion_disponible(
    p_habitacion_id INTEGER,
    p_fecha_entrada DATE,
    p_fecha_salida DATE,
    p_excluir_reserva_id INTEGER DEFAULT NULL
) RETURNS BOOLEAN AS $$
BEGIN
    RETURN NOT EXISTS (
        SELECT 1 FROM Reserva
        WHERE habitacion_id = p_habitacion_id
          AND estado IN ('Pendiente', 'Confirmada')
          AND (p_excluir_reserva_id IS NULL OR id != p_excluir_reserva_id)
          AND daterange(fecha_entrada, fecha_salida, '[)') &&
              daterange(p_fecha_entrada, p_fecha_salida, '[)')
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- FUNCIÓN: habitaciones_disponibles_en_rango (optimizada)
-- Devuelve IDs de habitaciones disponibles en un rango
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
      AND NOT EXISTS (
          SELECT 1 FROM Reserva r
          WHERE r.habitacion_id = h.id
            AND r.estado IN ('Pendiente', 'Confirmada')
            AND (p_excluir_reserva_id IS NULL OR r.id != p_excluir_reserva_id)
            AND daterange(r.fecha_entrada, r.fecha_salida, '[)') &&
                daterange(p_fecha_entrada, p_fecha_salida, '[)')
      )
    ORDER BY h.numero;
END;
$$ LANGUAGE plpgsql STABLE;

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
