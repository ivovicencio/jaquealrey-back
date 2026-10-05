-- Tipos de alojamiento disponibles para habitaciones y otros alojamientos.

ALTER TABLE Habitacion
    DROP CONSTRAINT IF EXISTS habitacion_tipo_check;

ALTER TABLE Habitacion
    ADD CONSTRAINT habitacion_tipo_check
    CHECK (tipo IN ('Doble', 'Triple', 'Cuádruple', 'Quíntuple', 'Departamento', 'Cabaña'));
