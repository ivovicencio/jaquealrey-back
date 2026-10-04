-- Tabla para guardar los tokens de notificaciones push de los dispositivos.
-- Un usuario puede tener varios dispositivos (Ej: Celular y PC).
CREATE TABLE IF NOT EXISTS DeviceTokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES Cliente(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    dispositivo VARCHAR(100), -- 'android', 'ios', 'web', 'windows', 'mac'
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, dispositivo)
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON DeviceTokens(user_id);
