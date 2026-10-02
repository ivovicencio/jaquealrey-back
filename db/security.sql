-- ============================================================
-- Endurecimiento de la base. Ejecutar DESPUES de init.sql y rls.sql.
-- Es idempotente: se puede correr las veces que haga falta.
--
-- Orden de los scripts (el que usa docker-compose.yml):
--   01-init.sql       tablas
--   02-rol.sql        crea jaquealrey_app
--   03-rls.sql        politicas + revocaciones
--   04-pagos.sql      Pago y Configuracion
--   05-seed.sql       datos iniciales
--   06-security.sql   este archivo: permisos y restricciones
--
-- 02-rol.sql va antes de 03 y 04 porque esos dos revocan privilegios sobre
-- jaquealrey_app, y PostgreSQL exige que el rol exista para revocarle algo.
--
-- Resuelve dos cosas que la auditoria de seguridad encontro:
--
--  1. RLS no se estaba aplicando. El rol que usa la app era SUPERUSER, y un
--     superusuario saltea Row Level Security siempre, sin importar la politica.
--     Las 16 politicas de rls.sql nunca se ejecutaron: eran decorativas. La
--     unica defensa real era el WHERE de cada consulta del codigo.
--
--  2. No habia nada que impidiera la sobreventa. El indice gist de init.sql
--     (idx_reserva_fechas_exclusion) pese al nombre es un CREATE INDEX, o sea
--     que solo acelera la busqueda: no impide dos reservas solapadas en la
--     misma habitacion. Faltaba la constraint EXCLUDE.
-- ============================================================

-- ----------------------------------------------------------------
-- 1. Rol de aplicacion: sin SUPERUSER y sin BYPASSRLS
-- ----------------------------------------------------------------
-- Este es el paso que hace que RLS empiece a valer. Con el rol anterior
-- (superusuario) las politicas no se evaluaban nunca.
--
-- El rol ya lo crea db/rol.sql, que corre antes porque rls.sql y pagos.sql
-- revocan privilegios sobre este mismo rol y PostgreSQL lo exige existente.
-- El bloque siguiente es idempotente y queda por si se corre este archivo
-- solo, sin el resto.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'jaquealrey_app') THEN
    CREATE ROLE jaquealrey_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- ----------------------------------------------------------------
-- 2. Permisos que la app necesita
-- ----------------------------------------------------------------
-- rls.sql le daba privileges a app_admin, un rol que nadie usa: la app nunca
-- hace SET ROLE, solo set_config('app.role'). Asi que los permisos se dan
-- directo al rol de aplicacion y el admin/public se resuelve por politica.
--
-- OJO con DELETE: no se otorga en bloque. Las tablas donde no se puede borrar
-- (Reserva, HistorialReserva, Pago) lo revocan rls.sql y pagos.sql, y un
-- "GRANT DELETE ON ALL TABLES" volveria a dárselo, deshaciendo esas
-- revocaciones en silencio. Se concede tabla por tabla en el paso 2b.
GRANT USAGE ON SCHEMA public TO jaquealrey_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO jaquealrey_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jaquealrey_app;

-- Para que las tablas que se agreguen en el futuro queden cubiertas solas.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO jaquealrey_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO jaquealrey_app;

-- ----------------------------------------------------------------
-- 2b. DELETE solo donde tiene sentido
-- ----------------------------------------------------------------
-- Hotel, Cliente y Habitacion se pueden borrar de verdad, asi que el permiso
-- se otorga de forma explicita. Las otras tres no: una reserva se cancela
-- cambiando el estado, la bitacora es solo de consulta y un pago se anula.
GRANT DELETE ON Hotel      TO jaquealrey_app;
GRANT DELETE ON Cliente    TO jaquealrey_app;
GRANT DELETE ON Habitacion TO jaquealrey_app;

-- Por si el archivo se corre dos veces sobre una base donde el GRANT en bloque
-- de una version anterior dejo DELETE en las tres tablas de arriba.
REVOKE DELETE ON Reserva         FROM jaquealrey_app;
REVOKE DELETE ON HistorialReserva FROM jaquealrey_app;
REVOKE DELETE ON Pago            FROM jaquealrey_app;

-- Configuracion no se puede borrar tampoco. Las claves (alias, anticipo,
-- recargo de tarjeta) se cambian con UPDATE, nunca con DELETE: si el rol de la
-- app pudiera borrar filas, un borrado accidental dejaria al hotel sin alias
-- bancario y sin anticipo, que es justo lo que el hotel necesita para cobrar.
REVOKE DELETE ON Configuracion FROM jaquealrey_app;

-- ----------------------------------------------------------------
-- 3. FORCE: los owners de las tablas tambien quedan sujetos a RLS
-- ----------------------------------------------------------------
-- ENABLE solo alcanza para los que NO son owners. FORCE ata tambien al owner.
-- Ojo: ni FORCE ata a un superusuario, por eso el paso 1 es el que importa.
--
-- Pago y Configuracion tambien: pagos.sql los deja en ENABLE y por eso no
-- quedaban cubiertos contra el owner. Con FORCE las cinco tablas quedan igual
-- de protegidas sin importar con que rol se conecte.
ALTER TABLE Hotel FORCE ROW LEVEL SECURITY;
ALTER TABLE Habitacion FORCE ROW LEVEL SECURITY;
ALTER TABLE Cliente FORCE ROW LEVEL SECURITY;
ALTER TABLE Reserva FORCE ROW LEVEL SECURITY;
ALTER TABLE HistorialReserva FORCE ROW LEVEL SECURITY;
ALTER TABLE Pago FORCE ROW LEVEL SECURITY;
ALTER TABLE Configuracion FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------
-- 4. Sobreventa: constraint EXCLUDE de verdad
-- ----------------------------------------------------------------
-- El indice de init.sql sigue aiding a la performance; esto agrega la garantia.
-- Ante una carrera entre el SELECT de disponibilidad y el INSERT, la segunda
-- reserva choca contra la constraint y Postgres la rechaza. Eso ya no depende
-- de que dos requests lleguen ordenados.
--
-- Requiere btree_gist, que init.sql ya instala.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reserva_sin_solapamiento') THEN
    ALTER TABLE Reserva ADD CONSTRAINT reserva_sin_solapamiento
      EXCLUDE USING gist (
        habitacion_id WITH =,
        daterange(fecha_entrada, fecha_salida, '[)') WITH &&
      )
      WHERE (estado IN ('Pendiente', 'Confirmada'));
  END IF;
END
$$;

-- ----------------------------------------------------------------
-- 5. La bitacora no es insertable por cualquiera
-- ------------------------------------------------------------------ historial_insert era WITH CHECK (true): cualquier request podia escribir en
-- el log de auditoria. La reserva y el cliente si necesitan INSERT publico
-- porque el huesped no se registra, pero la bitacora es interna de la app.
-- Los dos INSERT de reserva.controller.js se actualizan a role admin en el
-- mismo commit para acompanar este cambio.
DROP POLICY IF EXISTS historial_insert ON HistorialReserva;
CREATE POLICY historial_insert ON HistorialReserva FOR INSERT
    WITH CHECK (current_setting('app.role', true) = 'admin');

-- ----------------------------------------------------------------
-- 6. Revocacion de tokens, persistente
-- ----------------------------------------------------------------
-- Hoy el JWT servia hasta que vencia y no habia logout del lado del servidor:
-- con el token en la mano, un logout en la UI no cortaba nada.
-- Esta marca es el piso de validez: un token solo sirve si fue emitido despues
-- de ella. Login y logout la mueven hacia adelante, asi que quedan invalidados
-- todos los tokens anteriores. Al vivir en la base sobrevive reinicios y
-- serverless, cosa que una lista en memoria no haria.
ALTER TABLE Cliente ADD COLUMN IF NOT EXISTS tokens_validos_desde TIMESTAMPTZ;

-- ----------------------------------------------------------------
-- Verificacion
-- ----------------------------------------------------------------
-- Debe devolver 'f' en rolbypassrls para el rol de la app, y 't' en rls y
-- force para las cinco tablas:
--
--   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
--    WHERE rolname = 'jaquealrey_app';
--   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
--    WHERE relname IN ('hotel','habitacion','cliente','reserva',
--                      'historialreserva','pago','configuracion');
--
-- Las siete deben tener rls = t y force = t. Y el DELETE tiene que estar
-- permitido solo en hotel, cliente y habitacion:
--   SELECT relname, has_table_privilege('jaquealrey_app', oid, 'DELETE')
--     FROM pg_class WHERE relname IN
--       ('hotel','habitacion','cliente','reserva','historialreserva','pago',
--        'configuracion');   -- espera t t t f f f f
--   SELECT conname, contype FROM pg_constraint
--    WHERE conname = 'reserva_sin_solapamiento';   -- contype = 'x' (exclusion)
