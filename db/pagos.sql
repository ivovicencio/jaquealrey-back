-- ============================================================
-- Pagos e ingresos.
--
-- El hotel no usa Mercado Pago: cobra por transferencia a alias bancario. Asi que
-- no hay pasarela, no hay webhook que pueda falsearse y no hay comision. El flujo
-- es: el huesped ve los datos de la cuenta, transfiere, y el admin marca el pago
-- como confirmado desde el panel.
--
-- Eso significa que la base de pagos es de confianza interna: la registra el
-- admin, no el huesped. Por eso las politicas de esta tabla son solo de admin,
-- a diferencia de Reserva que si es escritura publica.
--
-- Ejecutar despues de rls.sql
-- ============================================================

-- ------------------------------------------------------------
-- Configuracion editable sin redesplegar
--
-- Los datos de la cuenta van en tabla y no en .env a proposito: el alias y el
-- titular los cambia el hotel cada vez que cambia de banco, y eso no puede
-- obligar a tocar el servidor ni a reiniciar nada.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Configuracion (
    id          SERIAL PRIMARY KEY,
    clave       VARCHAR(64) NOT NULL UNIQUE,
    valor       TEXT        NOT NULL,
    descripcion TEXT,
    updated_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- El huesped ve estos datos para transferir al alias. El anticipo es lo que
-- el hotel pide por adelantado.
INSERT INTO Configuracion (clave, valor, descripcion) VALUES
    ('alias_bancario',      'jaquealrey.mp',       'Alias/CBU al que paga el huesped'),
    ('titular_cuenta',      'PENDIENTE-DE-CARGAR', 'Titular de la cuenta bancaria'),
    ('banco_nombre',        'PENDIENTE-DE-CARGAR', 'Banco de la cuenta'),
    ('moneda',              'ARS',                 'Moneda de los precios'),
    ('anticipo_porcentaje', '30',                  'Porcentaje que se pide por adelantado')
ON CONFLICT (clave) DO NOTHING;

-- ------------------------------------------------------------
-- Pago
--
-- Se permiten varios pagos por reserva a proposito: un hotel cobra por adelantado
-- una seña y después el saldo. Lo que no se permite es que un pago quede
--Confirmedo sin fecha, porque "ingresos" sin fecha no se pueden ordenar ni
--reportar por mes.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Pago (
    id         SERIAL      PRIMARY KEY,
    -- ON DELETE RESTRICT, no CASCADE, y a proposito.
    --
    -- Cliente se borra en cascada sobre Reserva, asi que un CASCADE aqui
    -- significaria que borrar un cliente borra en silencio todos sus pagos, que
    -- son los comprobantes de plata que el hotel recibio. Con RESTRICT el borrado
    -- falla con 23503 y queda a la vista: un cliente con movimientos no se
    -- borra, se conserva. Es la contabilidad poniendole un candado.
    reserva_id INTEGER      NOT NULL REFERENCES Reserva(id) ON DELETE RESTRICT,
    monto      NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    -- El metodo no incluye 'tarjeta' a proposito: el hotel cobra por alias o
    -- efectivo. Guardar datos de tarjeta aca seria un circuito legal que no
    -- aplica a un hotel de 10 habitaciones. Si algun dia se cobra con tarjeta,
    -- es con un terminal fisico del banco, no con este sistema.
    metodo     VARCHAR(20)  NOT NULL DEFAULT 'alias'
                        CHECK (metodo IN ('alias', 'efectivo', 'otro')),
    estado     VARCHAR(20)  NOT NULL DEFAULT 'Pendiente'
                        CHECK (estado IN ('Pendiente', 'Confirmado', 'Anulado')),
    referencia VARCHAR(120),
    fecha_pago TIMESTAMP,
    notas      TEXT,
    created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP    NOT NULL DEFAULT NOW(),

    -- Un pago confirmado siempre tiene fecha. Sin esto se podrian registrar
    -- ingresos que no entran en ningun reporte mensual.
    CONSTRAINT pago_confirmado_con_fecha
        CHECK (estado <> 'Confirmado' OR fecha_pago IS NOT NULL)
);

-- Los pagos de una reserva se consultan siempre por reserva, en orden de fecha.
CREATE INDEX IF NOT EXISTS idx_pago_reserva      ON Pago (reserva_id);
-- El reporte de ingresos filtra por estado + fecha.
CREATE INDEX IF NOT EXISTS idx_pago_estado_fecha ON Pago (estado, fecha_pago);
CREATE INDEX IF NOT EXISTS idx_pago_fecha        ON Pago (fecha_pago DESC);

-- Un pago confirmado por referencia de transferencia no se puede registrar dos
-- veces. Es la defensa contra doble carga al marcar el mismo comprobante.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pago_referencia_unica
    ON Pago (referencia)
    WHERE referencia IS NOT NULL AND estado = 'Confirmado';

-- ------------------------------------------------------------
-- RLS
--
-- Solo admin. El huesped nunca lee ni escribe pagos: verlos sin login seria una
-- fuga de datos financieros, y escribirlos le permitiria confirmar su propia
-- reserva sin transferir.
-- ------------------------------------------------------------
ALTER TABLE Pago ENABLE ROW LEVEL SECURITY;
ALTER TABLE Configuracion ENABLE ROW LEVEL SECURITY;

CREATE POLICY pago_select_admin ON Pago FOR SELECT
    USING (current_setting('app.role', true) = 'admin');
CREATE POLICY pago_insert_admin ON Pago FOR INSERT
    WITH CHECK (current_setting('app.role', true) = 'admin');
CREATE POLICY pago_update_admin ON Pago FOR UPDATE
    USING (current_setting('app.role', true) = 'admin')
    WITH CHECK (current_setting('app.role', true) = 'admin');

-- No hay politica DELETE a proposito, igual que en Reserva: un pago se anula
-- (estado = 'Anulado'), no se borra. Si hiciera falta eliminarlo, el DELETE
-- falla con permission denied en vez de fingir que funciono.
REVOKE DELETE ON Pago FROM jaquealrey_app;

-- La configuracion de cobro si es de lectura publica: el huesped necesita ver el
-- alias para poder transferir. Solo se expone lo de cobro, y el admin escribe.
CREATE POLICY configuracion_select_public ON Configuracion FOR SELECT USING (true);
CREATE POLICY configuracion_update_admin ON Configuracion FOR UPDATE
    USING (current_setting('app.role', true) = 'admin')
    WITH CHECK (current_setting('app.role', true) = 'admin');
CREATE POLICY configuracion_insert_admin ON Configuracion FOR INSERT
    WITH CHECK (current_setting('app.role', true) = 'admin');

-- Deliberadamente NO se crea una vista SQL de ingresos.
-- Las vistas se ejecutan con los permisos de su duenio (aqui el superusuario) y
-- por eso se saltan las politicas de las tablas de abajo: una vista sobre Pago
-- expondría los ingresos a cualquiera que llegara a ella, sin importar el rol.
-- El resumen de ingresos se calcula en el controlador admin con una consulta
-- normal, que si pasa por RLS y queda filtrada por role = 'admin'.