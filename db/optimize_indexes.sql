-- These indexes duplicate indexes PostgreSQL already maintains for the
-- exclusion constraint and the UNIQUE constraint on Reserva.codigo.
-- Keep the constraint-backed and constraint-owned indexes; remove only the
-- extra standalone copies.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.reserva'::regclass
      AND conname = 'reserva_sin_solapamiento'
  ) THEN
    RAISE EXCEPTION
      'Cannot remove idx_reserva_fechas_exclusion: reserva_sin_solapamiento is missing';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.idx_reserva_fechas_exclusion;
DROP INDEX IF EXISTS public.idx_reserva_codigo;
