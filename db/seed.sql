-- ============================================================
-- Seed: Hotel Jaque al Rey
-- ============================================================

-- Hotel
INSERT INTO Hotel (nombre, direccion, telefono, descripcion)
VALUES (
    'Jaque al Rey',
    'Julio Argentino Roca, Q8315 Piedra del Águila, Neuquén',
    '02942664320',
    'Hotel familiar en el corazón de Piedra del Águila'
);

-- Habitaciones
INSERT INTO Habitacion (numero, nombre, descripcion, camas_individuales, camas_matrimoniales, capacidad_max, tipo, precio_noche) VALUES
(1, 'Habitación 1', 'Tres camas individuales, ideal para grupos de amigos.', 3, 0, 3, 'Triple', 70000),
(2, 'Habitación 2', 'Una cama matrimonial más una individual.', 1, 1, 3, 'Triple', 70000),
(3, 'Habitación 3', 'Matrimonial con dos camas individuales, máxima capacidad.', 2, 1, 4, 'Cuádruple', 80000),
(4, 'Habitación 4', 'Tres camas individuales.', 3, 0, 3, 'Triple', 70000),
(5, 'Habitación 5', 'Dos camas individuales, acogedora.', 2, 0, 2, 'Doble', 60000),
(6, 'Habitación 6', 'Cama matrimonial, perfecta para parejas.', 0, 1, 2, 'Doble', 60000),
(7, 'Habitación 7', 'Matrimonial con una individual.', 1, 1, 3, 'Triple', 70000),
(8, 'Habitación 8', 'Matrimonial con dos individuales.', 2, 1, 4, 'Cuádruple', 80000),
(9, 'Habitación 9', 'Matrimonial con una individual.', 1, 1, 3, 'Triple', 70000),
(10, 'Habitación 10', 'Matrimonial con dos individuales.', 2, 1, 4, 'Cuádruple', 80000);
