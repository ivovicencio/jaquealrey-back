-- ============================================================
-- RLS: Hotel Jaque al Rey
-- Ejecutar después de init.sql
-- ============================================================

-- 1. Crear roles de aplicación
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_public') THEN
    CREATE ROLE app_public;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin;
  END IF;
END
$$;

-- 2. Permisos esquema
GRANT USAGE ON SCHEMA public TO app_public, app_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;

-- 3. Habilitar RLS en todas las tablas
ALTER TABLE Hotel ENABLE ROW LEVEL SECURITY;
ALTER TABLE Habitacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE Cliente ENABLE ROW LEVEL SECURITY;
ALTER TABLE Reserva ENABLE ROW LEVEL SECURITY;
ALTER TABLE HistorialReserva ENABLE ROW LEVEL SECURITY;

-- 4. Políticas: Hotel (lectura pública, escritura admin)
CREATE POLICY hotel_select_public ON Hotel FOR SELECT USING (true);
CREATE POLICY hotel_insert_admin ON Hotel FOR INSERT
    WITH CHECK (current_setting('app.role', true) = 'admin');
CREATE POLICY hotel_update_admin ON Hotel FOR UPDATE
    USING (current_setting('app.role', true) = 'admin')
    WITH CHECK (current_setting('app.role', true) = 'admin');

-- 5. Políticas: Habitación (lectura pública, CRUD admin)
CREATE POLICY habitacion_select_public ON Habitacion FOR SELECT
    USING (activa = true OR current_setting('app.role', true) = 'admin');
CREATE POLICY habitacion_insert_admin ON Habitacion FOR INSERT
    WITH CHECK (current_setting('app.role', true) = 'admin');
CREATE POLICY habitacion_update_admin ON Habitacion FOR UPDATE
    USING (current_setting('app.role', true) = 'admin')
    WITH CHECK (current_setting('app.role', true) = 'admin');
CREATE POLICY habitacion_delete_admin ON Habitacion FOR DELETE
    USING (current_setting('app.role', true) = 'admin');

-- 6. Políticas: Cliente
CREATE POLICY cliente_insert_public ON Cliente FOR INSERT WITH CHECK (true);
CREATE POLICY cliente_select_self ON Cliente FOR SELECT
    USING (id::text = current_setting('app.user_id', true)
           OR current_setting('app.role', true) = 'admin');
CREATE POLICY cliente_update_self ON Cliente FOR UPDATE
    USING (id::text = current_setting('app.user_id', true))
    WITH CHECK (id::text = current_setting('app.user_id', true));
CREATE POLICY cliente_update_admin ON Cliente FOR UPDATE
    USING (current_setting('app.role', true) = 'admin')
    WITH CHECK (current_setting('app.role', true) = 'admin');

-- 7. Políticas: Reserva
CREATE POLICY reserva_insert_public ON Reserva FOR INSERT WITH CHECK (true);
CREATE POLICY reserva_select_self ON Reserva FOR SELECT
    USING (cliente_id::text = current_setting('app.user_id', true)
           OR current_setting('app.role', true) = 'admin');
CREATE POLICY reserva_update_admin ON Reserva FOR UPDATE
    USING (current_setting('app.role', true) = 'admin')
    WITH CHECK (current_setting('app.role', true) = 'admin');

-- 8. Políticas: HistorialReserva
CREATE POLICY historial_select_admin ON HistorialReserva FOR SELECT
    USING (current_setting('app.role', true) = 'admin');
CREATE POLICY historial_insert ON HistorialReserva FOR INSERT WITH CHECK (true);
