-- ============================================================
-- Rol de aplicacion. Va PRIMERO, antes de rls.sql y pagos.sql.
-- Es idempotente: se puede correr las veces que haga falta.
--
-- Por que este archivo existe:
--
-- rls.sql y pagos.sql revocan privilegios sobre tablas concretas
-- (REVOKE DELETE ON Reserva FROM jaquealrey_app). PostgreSQL exige que
-- el rol exista para revocarle algo: si no esta, tira
-- "role jaquealrey_app does not exist" y aborta el script.
--
-- Con el orden anterior (init, rls, pagos, seed, security) el rol se
-- creaba recien en security.sql, o sea DESPUES. Cualquier instalacion
-- limpia fallaba en rls.sql y dejaba la base a medio construir.
--
-- No hay ningun GRANT aqui. Los permisos por tabla llegan despues, en
-- security.sql, una vez que todas las tablas existen.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'jaquealrey_app') THEN
    -- NOSUPERUSER: sin esto se saltea RLS siempre y las politicas son decorativas.
    -- NOBYPASSRLS: impide esquivarse de RLS con el atributo de rol.
    CREATE ROLE jaquealrey_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- ----------------------------------------------------------------
-- Verificacion
-- ----------------------------------------------------------------
--   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
--    WHERE rolname = 'jaquealrey_app';
--
-- Debe existir con rolsuper = f y rolbypassrls = f.