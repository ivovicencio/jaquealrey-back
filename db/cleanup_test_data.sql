-- Conservative, preview-first cleanup. A row is considered test data only
-- when its client email clearly contains a test/fake/demo marker or uses a
-- reserved example/invalid domain. Only public-origin reservations that are
-- still Pending or Cancelled and have no check-in/out can be removed.
--
-- Preview (default): psql ... -f db/cleanup_test_data.sql
-- Apply after reviewing preview: psql ... -v apply_cleanup=true -f ...
-- This script never deletes Hotel or Habitacion rows.

\if :{?apply_cleanup}
\else
\set apply_cleanup false
\endif

BEGIN;

CREATE TEMP TABLE cleanup_test_clients ON COMMIT DROP AS
SELECT c.id
FROM Cliente c
WHERE lower(c.email) ~ '(^|[.+_-])(test|fake|demo|dummy)([.+_-]|@)'
   OR lower(split_part(c.email, '@', 2)) IN
      ('example.com', 'example.net', 'example.org', 'example.invalid', 'invalid', 'test');

CREATE TEMP TABLE cleanup_test_reservations ON COMMIT DROP AS
SELECT r.id
FROM Reserva r
JOIN cleanup_test_clients c ON c.id = r.cliente_id
WHERE r.origen = 'public'
  AND r.estado IN ('Pendiente', 'Cancelada')
  AND r.check_in_at IS NULL
  AND r.check_out_at IS NULL;

\echo 'Candidate test clients:'
SELECT c.id, 'test/fake/demo marker' AS matching_reason
FROM Cliente c
JOIN cleanup_test_clients t ON t.id = c.id
ORDER BY c.id;

\echo 'Candidate public reservations:'
SELECT r.id, r.estado, r.origen
FROM Reserva r
JOIN cleanup_test_reservations t ON t.id = r.id
ORDER BY r.id;

\echo 'Candidate payments attached to those reservations:'
SELECT p.id, p.reserva_id, p.estado
FROM Pago p
JOIN cleanup_test_reservations t ON t.id = p.reserva_id
ORDER BY p.id;

\if :apply_cleanup
DELETE FROM Pago p
USING cleanup_test_reservations t
WHERE p.reserva_id = t.id;

DELETE FROM Reserva r
USING cleanup_test_reservations t
WHERE r.id = t.id;

-- Retain test-marked clients if they still have any non-candidate reservation.
DELETE FROM Cliente c
USING cleanup_test_clients t
WHERE c.id = t.id
  AND NOT EXISTS (SELECT 1 FROM Reserva r WHERE r.cliente_id = c.id);

COMMIT;
\echo 'Cleanup committed.'
\else
ROLLBACK;
\echo 'Preview only; no rows were deleted. Re-run with -v apply_cleanup=true only after review.'
\endif

VACUUM (ANALYZE) Reserva, Pago, Habitacion, Cliente, HistorialReserva;
