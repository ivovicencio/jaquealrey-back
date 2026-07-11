# Arquitectura del Sistema: Hotel Jaque al Rey

## 1. Análisis del Negocio

### 1.1 Visión General
Hotel **Jaque al Rey** ubicado en Piedra del Águila, Neuquén. El sistema permite a huéspedes potenciales **reservar habitaciones** desde una web pública (Angular) y al personal **administrar** esas reservas desde una aplicación interna de escritorio/celular.

### 1.2 Actor del Sistema

| Actor | Descripción |
|-------|-------------|
| **Visitante (Público)** | Explora habitaciones, consulta disponibilidad y realiza reservas. Sin autenticación. |
| **Cliente (Registrado)** | Puede ver su historial, cancelar sus propias reservas. Autenticado con JWT. |
| **Admin (Interno)** | CRUD completo de habitaciones, reservas, clientes, precios. Acceso interno protegido. |

### 1.3 Habitaciones y Precios

| # | Camas | Capacidad | Tipo | Precio/noche |
|---|-------|-----------|------|-------------|
| 1 | 3 individuales | 3 pax | Triple | $70.000 |
| 2 | 1 matrimonial + 1 individual | 3 pax | Triple | $70.000 |
| 3 | 1 matrimonial + 2 individuales | 4 pax | Cuádruple | $80.000 |
| 4 | 3 individuales | 3 pax | Triple | $70.000 |
| 5 | 2 individuales | 2 pax | Doble | $60.000 |
| 6 | 1 matrimonial | 2 pax | Doble | $60.000 |
| 7 | 1 matrimonial + 1 individual | 3 pax | Triple | $70.000 |
| 8 | 1 matrimonial + 2 individuales | 4 pax | Cuádruple | $80.000 |
| 9 | 1 matrimonial + 1 individual | 3 pax | Triple | $70.000 |
| 10 | 1 matrimonial + 2 individuales | 4 pax | Cuádruple | $80.000 |

### 1.4 Funcionalidades Esenciales
- **Explorar habitaciones** (público, con filtros por tipo/capacidad/precio/fechas)
- **Realizar reserva** (público, con datos de contacto)
- **Confirmar reserva** (opcional, vía email/token)
- **Cancelar reserva** (cliente autenticado o admin)
- **Historial de reservas** (cliente ve las suyas, admin ve todas)
- **CRUD Habitaciones** (admin)
- **CRUD Clientes** (admin)
- **Dashboard admin** (reservas activas, próximas, históricas)

### 1.5 Información del Hotel
- **Dirección:** Julio Argentino Roca, Q8315 Piedra del Águila, Neuquén
- **Teléfono:** 02942664320

---

## 2. Stack Tecnológico

| Capa | Tecnología | Versión |
|------|-----------|---------|
| Runtime | Node.js | 18+ LTS |
| Framework | Express | 5.x |
| Base de datos | PostgreSQL (Supabase) | 15+ |
| Driver DB | `pg` | 8.x |
| Autenticación | JWT + bcryptjs | — |
| Cache (opcional) | Redis (Upstash / Railway) | 7+ |
| Seguridad | Helmet + CORS + express-rate-limit | — |
| Despliegue | Vercel (serverless functions) | — |

### 2.1 Dependencias npm
```json
{
  "dependencies": {
    "express": "^5.2.1",
    "cors": "^2.8.6",
    "helmet": "^8.2.0",
    "compression": "^1.8.1",
    "express-rate-limit": "^8.5.2",
    "dotenv": "^17.4.2",
    "pg": "^8.21.0",
    "jsonwebtoken": "^9.0.3",
    "bcryptjs": "^3.0.3",
    "ioredis": "^5.11.1"
  },
  "devDependencies": {
    "nodemon": "^3.1.14"
  }
}
```

---

## 3. Diseño de Base de Datos

### 3.1 Esquema Relacional

```sql
-- ============================================================
-- Hotel Jaque al Rey - Esquema Completo
-- ============================================================

-- Información del hotel (una sola fila)
CREATE TABLE Hotel (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL DEFAULT 'Jaque al Rey',
    direccion VARCHAR(255) NOT NULL,
    telefono VARCHAR(20) NOT NULL,
    email VARCHAR(150),
    descripcion TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Habitaciones
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

-- Clientes (huéspedes)
CREATE TABLE Cliente (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    apellido VARCHAR(100) NOT NULL DEFAULT '',
    telefono VARCHAR(20) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Reservas
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

-- Historial de cambios en reservas (log inmutable)
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
-- Índices
-- ============================================================
CREATE INDEX idx_habitacion_tipo ON Habitacion(tipo);
CREATE INDEX idx_habitacion_activa ON Habitacion(activa);

CREATE INDEX idx_reserva_cliente ON Reserva(cliente_id);
CREATE INDEX idx_reserva_habitacion ON Reserva(habitacion_id);
CREATE INDEX idx_reserva_fechas ON Reserva(fecha_entrada, fecha_salida);
CREATE INDEX idx_reserva_estado ON Reserva(estado);
CREATE UNIQUE INDEX idx_reserva_codigo ON Reserva(codigo);

CREATE INDEX idx_historial_reserva ON HistorialReserva(reserva_id);
CREATE INDEX idx_historial_fecha ON HistorialReserva(created_at);

-- ============================================================
-- Función para verificar disponibilidad (usada por RLS y controllers)
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
          AND (fecha_entrada, fecha_salida) OVERLAPS (p_fecha_entrada, p_fecha_salida)
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- Trigger: actualizar updated_at en Reserva
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
```

### 3.2 Row Level Security (RLS) — Supabase

```sql
-- ============================================================
-- RLS: Hotel Jaque al Rey
-- Ejecutar en Supabase SQL Editor después de crear tablas
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
```

### 3.3 Seed Data

```sql
-- Hotel
INSERT INTO Hotel (nombre, direccion, telefono, descripcion)
VALUES (
    'Jaque al Rey',
    'Julio Argentino Roca, Q8315 Piedra del Águila, Neuquén',
    '02942664320',
    'Hotel familiar en el corazón de Piedra del Águila'
);

-- Habitaciones (basado en datos del dueño)
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
```

---

## 4. Diseño de API

### 4.1 Formato de Respuesta Estandarizado
```json
// Éxito
{ "status": "1", "msg": "Mensaje", "data": {} }

// Error
{ "status": "0", "msg": "Mensaje de error", "data": [] }

// Validación
{ "status": "0", "msg": "Error de validación", "data": ["campo1: error"] }
```

### 4.2 Endpoints

#### Públicos (sin autenticación)

| Método | Ruta | Descripción | Rate Limit |
|--------|------|-------------|------------|
| GET | `/` | Health check | 200/15min |
| GET | `/api/hotel` | Info del hotel | 200/15min |
| GET | `/api/habitaciones` | Listar habitaciones disponibles (con filtros) | 200/15min |
| GET | `/api/habitaciones/:id` | Detalle de habitación | 200/15min |
| GET | `/api/habitaciones/disponibles` | Habitaciones disponibles en rango de fechas | 200/15min |
| POST | `/api/auth/register` | Registro de cliente | 5/hora |
| POST | `/api/auth/login` | Inicio de sesión | 10/15min |

#### Público — Reservas (con rate limit extra)

| Método | Ruta | Descripción | Rate Limit |
|--------|------|-------------|------------|
| POST | `/api/reservas` | Crear reserva (público) | 20/15min |

#### Protegidas (JWT requerido)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/reservas/mis-reservas` | Historial de reservas del cliente autenticado |
| GET | `/api/reservas/:id` | Detalle de reserva (propia o admin) |
| PUT | `/api/reservas/:id/cancelar` | Cancelar reserva (cliente dueño o admin) |
| GET | `/api/clientes/:id` | Perfil del cliente |
| PUT | `/api/clientes/:id` | Actualizar perfil propio |

#### Admin (JWT + rol admin, rate limit estricto)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/admin/habitaciones` | Crear habitación |
| PUT | `/api/admin/habitaciones/:id` | Actualizar habitación |
| DELETE | `/api/admin/habitaciones/:id` | Desactivar/eliminar habitación |
| GET | `/api/admin/reservas` | Todas las reservas (con filtros, paginación) |
| GET | `/api/admin/reservas/:id` | Detalle completo de reserva |
| PUT | `/api/admin/reservas/:id/estado` | Cambiar estado de reserva |
| GET | `/api/admin/clientes` | Listar todos los clientes |
| GET | `/api/admin/clientes/:id` | Detalle de cliente con sus reservas |
| GET | `/api/admin/historial` | Log completo de cambios |
| GET | `/api/admin/dashboard` | Estadísticas (reservas activas, próximas, ingresos) |
| PUT | `/api/admin/hotel` | Actualizar info del hotel |

### 4.3 Filtros GET /api/habitaciones
```
?tipo=Doble&tipo=Triple           — Por tipo(s)
?capacidad_min=3                   — Capacidad mínima
?precio_max=70000                  — Precio máximo
?disponible_desde=2026-07-01       — Filtro de disponibilidad
?disponible_hasta=2026-07-05       — Rango de fechas
```

### 4.4 Código de Reserva
Formato: `JAR-XXXXXX` donde XXXXXX son 6 caracteres alfanuméricos generados con `crypto.randomBytes`.

---

## 5. Arquitectura del Código

```
/
├── index.js                    # Entry point (Express setup + middlewares globales)
├── package.json
├── .env                        # Variables de entorno (NO se sube)
├── .env.example                # Template de variables (SÍ se sube)
├── vercel.json                 # Config de deploy en Vercel
│
├── db/
│   ├── index.js                # Re-export de pool + executeQuery
│   ├── pool.js                 # Pool de PostgreSQL (conexión Supabase)
│   ├── cache.js                # Redis cache (opcional, para Vercel Edge)
│   ├── init.sql                # Schema completo
│   ├── rls.sql                 # Políticas RLS
│   └── seed.sql               # Datos iniciales (habitaciones + hotel)
│
├── controllers/
│   ├── auth.controller.js      # Register / Login
│   ├── habitacion.controller.js # CRUD habitaciones + disponibilidad
│   ├── reserva.controller.js   # Crear, cancelar, historial
│   ├── cliente.controller.js   # Perfil cliente
│   ├── admin.controller.js     # Dashboard y operaciones admin
│   └── hotel.controller.js     # Info del hotel
│
├── routes/
│   ├── auth.route.js
│   ├── habitacion.route.js
│   ├── reserva.route.js
│   ├── cliente.route.js
│   ├── admin.route.js
│   └── hotel.route.js
│
├── middlewares/
│   ├── auth.middleware.js      # verifyToken + verifyAdmin
│   ├── validator.js            # Validación de schemas
│   ├── errorHandler.js         # Manejo global de errores
│   └── rateLimiter.js          # Rate limiters reutilizables
│
└── utils/
    ├── generateCode.js         # Generador de códigos de reserva
    └── response.js             # Helpers de respuesta estandarizada
```

---

## 6. Modelo de Seguridad

### 6.1 Capas de Seguridad (Defense in Depth)

```
┌──────────────────────────────────────────────────┐
│  Capa 1: Helmet (Headers HTTP de seguridad)      │
│  - CSP: default-src 'none', connect-src 'self'   │
│  - HSTS (producción, max-age=31536000)           │
│  - X-Content-Type-Options: nosniff               │
│  - X-Frame-Options: DENY                         │
│  - Referrer-Policy: no-referrer                  │
├──────────────────────────────────────────────────┤
│  Capa 2: CORS (Solo orígenes permitidos)         │
│  - Lista blanca configurable via CORS_ORIGIN     │
│  - Sin wildcard en producción                     │
├──────────────────────────────────────────────────┤
│  Capa 3: Rate Limiting                           │
│  - Global: 200 req/15min por IP                  │
│  - Auth login: 10 intentos/15min                 │
│  - Auth register: 5 intentos/hora                │
│  - Reservas: 20 solicitudes/15min                │
│  - Admin: aún más estricto                       │
├──────────────────────────────────────────────────┤
│  Capa 4: Autenticación JWT                       │
│  - Token 24h, firmado con JWT_SECRET             │
│  - Bearer en header Authorization                │
│  - También x-access-token como fallback          │
├──────────────────────────────────────────────────┤
│  Capa 5: Validación de Input                     │
│  - Schemas de validación en cada ruta            │
│  - SQL parametrizado: $1, $2 (cero inyección)   │
│  - Límite de tamaño en body: 1mb                 │
├──────────────────────────────────────────────────┤
│  Capa 6: Row Level Security (PostgreSQL)         │
│  - Roles app_public / app_admin                  │
│  - Políticas por tabla (SELECT/INSERT/UPDATE)    │
│  - app.role y app.user_id via SET LOCAL          │
├──────────────────────────────────────────────────┤
│  Capa 7: Validación de entorno al arranque       │
│  - JWT_SECRET obligatorio                        │
│  - DATABASE_URL obligatorio                      │
│  - CORS_ORIGIN obligatorio en producción         │
│  - Exit early si falta alguna                    │
├──────────────────────────────────────────────────┤
│  Capa 8: Graceful Shutdown                       │
│  - Cierre ordenado de pool PostgreSQL            │
│  - Timeout forzado de 10s                        │
│  - Manejo de SIGTERM y SIGINT                    │
└──────────────────────────────────────────────────┘
```

### 6.2 Variables de Entorno (.env)

```env
# Entorno
NODE_ENV=development

# Puerto
PORT=3000

# PostgreSQL (Docker local)
DATABASE_URL=postgresql://jaquealrey:jaquealrey123@127.0.0.1:5432/jaquealrey

# JWT
JWT_SECRET=generar_con_openssl_rand_-hex_64
JWT_EXPIRES_IN=86400

# CORS (separar múltiples orígenes con coma)
CORS_ORIGIN=http://localhost:4200

# Redis (opcional)
REDIS_URL=redis://localhost:6379
CACHE_TTL=60

# Admin
ADMIN_EMAIL=admin@jaquealrey.com
ADMIN_SECRET=tu_admin_secret_aqui

# WhatsApp Cloud API (opcional)
WHATSAPP_TOKEN=
WHATSAPP_PHONE_ID=
ADMIN_WHATSAPP=

# MercadoPago (opcional)
MP_ACCESS_TOKEN=
BASE_URL=http://localhost:3000
```

### 6.3 Flujo de Autenticación

```
Registro:
  POST /api/auth/register { nombre, telefono, email, password, admin_secret? }
  → Si email === ADMIN_EMAIL y ADMIN_SECRET está configurado, requiere admin_secret
  → bcrypt(password, salt=12)
  → INSERT INTO Cliente
  → jwt.sign({ id, email, role: 'admin'|'cliente' })
  → { status: '1', data: { user, token } }

Login:
  POST /api/auth/login { email, password }
  → buscar_cliente_por_email($1) (SECURITY DEFINER, bypass RLS)
  → bcrypt.compare(password, hash)
  → jwt.sign({ id, email, role })
  → { status: '1', data: { user, token } }

Cambio de password:
  PUT /api/auth/password { password_actual, password_nueva }
  → Requiere JWT en header
  → Verifica password_actual con bcrypt.compare
  → bcrypt.hash(password_nueva, salt=12)
  → UPDATE Cliente SET password = $1

Acceso Admin:
  POST /api/auth/login { email, password }
  → Si email === ADMIN_EMAIL → role: 'admin'
  → El middleware verifyAdmin checkea decoded.role === 'admin'
```

### 6.4 Manejo de Errores

El error handler global captura:
- `23505`: Unique violation (registro duplicado)
- `23503`: Foreign key violation
- `22P02`: Invalid data type
- Cualquier error no manejado → 500 Internal Server Error

Nunca se exponen detalles internos (stack traces) al cliente en producción.

---

## 7. Plan de Implementación (Orden Estricto)

### Fase 1: Inicialización del Proyecto
```
Paso 1.1: npm init -y
Paso 1.2: npm install express cors helmet compression express-rate-limit dotenv pg jsonwebtoken bcryptjs
Paso 1.3: npm install -D nodemon
Paso 1.4: Crear .env con variables del hotel
Paso 1.5: Crear .env.example (template sin secrets)
Paso 1.6: Configurar vercel.json
Paso 1.7: Configurar scripts en package.json (dev, start)
```

### Fase 2: Base de Datos (Supabase)
```
Paso 2.1: Crear proyecto en Supabase
Paso 2.2: Ejecutar init.sql en SQL Editor
Paso 2.3: Ejecutar rls.sql para políticas de seguridad
Paso 2.4: Ejecutar seed.sql para datos iniciales
Paso 2.5: Verificar RLS probando queries con diferentes roles
```

### Fase 3: Conexión a DB
```
Paso 3.1: Crear db/pool.js (conexión a Supabase via DATABASE_URL)
Paso 3.2: Crear db/index.js (Pool + executeQuery con soporte RLS)
Paso 3.3: Crear db/cache.js (Redis opcional)
Paso 3.4: Probar conexión con consulta simple
```

### Fase 4: Middlewares Base
```
Paso 4.1: middlewares/auth.middleware.js (verifyToken + verifyAdmin)
Paso 4.2: middlewares/validator.js (schemas de validación)
Paso 4.3: middlewares/errorHandler.js (manejo global de errores)
Paso 4.4: middlewares/rateLimiter.js (limiters reutilizables)
```

### Fase 5: Entry Point (index.js)
```
Paso 5.1: Configurar middlewares globales (compression, helmet, cors, body parser)
Paso 5.2: Configurar rate limit global
Paso 5.3: Configurar rutas (montar cada módulo)
Paso 5.4: Configurar error handler
Paso 5.5: Graceful shutdown
```

### Fase 6: Módulo Auth
```
Paso 6.1: controllers/auth.controller.js (register + login)
Paso 6.2: routes/auth.route.js (POST /register con registerLimiter, POST /login con loginLimiter)
Paso 6.3: Schemas de validación para register y login
```

### Fase 7: Módulo Hotel
```
Paso 7.1: controllers/hotel.controller.js (GET info)
Paso 7.2: routes/hotel.route.js (GET /api/hotel)
```

### Fase 8: Módulo Habitaciones
```
Paso 8.1: controllers/habitacion.controller.js (listar con filtros, detalle, disponibilidad)
Paso 8.2: routes/habitacion.route.js (GET públicas)
Paso 8.3: Validación de filtros y parámetros
```

### Fase 9: Módulo Reservas (CORAZÓN del sistema)
```
Paso 9.1: utils/generateCode.js (código JAR-XXXXXX)
Paso 9.2: controllers/reserva.controller.js (crear, cancelar, historial propio)
Paso 9.3: routes/reserva.route.js
  - POST /api/reservas (público, con leadLimiter) → crea cliente si no existe
  - GET /api/reservas/mis-reservas (protegido)
  - GET /api/reservas/:id (protegido)
  - PUT /api/reservas/:id/cancelar (protegido)
Paso 9.4: Validación de fechas (no重叠, check disponibilidad, mínimo 1 noche)
```

### Fase 10: Módulo Clientes
```
Paso 10.1: controllers/cliente.controller.js (perfil, actualizar)
Paso 10.2: routes/cliente.route.js
  - GET /api/clientes/:id (protegido, solo propio o admin)
  - PUT /api/clientes/:id (protegido, solo propio o admin)
```

### Fase 11: Módulo Admin
```
Paso 11.1: controllers/admin.controller.js (dashboard, CRUD habitaciones, gestión reservas, clientes)
Paso 11.2: routes/admin.route.js (todas protegidas con verifyToken + verifyAdmin)
Paso 11.3: Rate limiters estrictos para admin
```

### Fase 12: Cache (Redis - Opcional)
```
Paso 12.1: Configurar Upstash Redis (plan gratuito, Serverless)
Paso 12.2: Cachear listado de habitaciones (invalidar al crear/editar)
Paso 12.3: Cachear info del hotel
```

### Fase 13: Despliegue en Vercel
```
Paso 13.1: Crear vercel.json
Paso 13.2: Conectar repo de GitHub a Vercel
Paso 13.3: Configurar variables de entorno en Vercel Dashboard
Paso 13.4: Desplegar y verificar
Paso 13.5: Configurar dominio personalizado (opcional)
```

### Fase 14: Testing y Hardening
```
Paso 14.1: Probar todos los endpoints con curl/Postman
Paso 14.2: Probar inyección SQL
Paso 14.3: Probar CORS desde origen no autorizado
Paso 14.4: Probar rate limiting (exceder límites)
Paso 14.5: Probar RLS (intentar leer datos como app_public)
Paso 14.6: Probar graceful shutdown
Paso 14.7: Prueba de carga básica con autocannon/artillery
```

---

## 8. Despliegue en Vercel

### 8.1 vercel.json
```json
{
  "version": 2,
  "builds": [
    {
      "src": "index.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "index.js"
    }
  ]
}
```

### 8.2 Variables de Entorno en Vercel
| Variable | Valor |
|----------|-------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Conexión Supabase (Pooler: ?pgbouncer=true) |
| `JWT_SECRET` | Clave secreta de 64 caracteres hex |
| `CORS_ORIGIN` | `https://www.jaquealrey.com,https://jaquealrey.com` |
| `REDIS_URL` | Upstash Redis URL (opcional) |

### 8.3 Supabase Connection Pooling
En Vercel (serverless), las funciones se enfrían. Usar **Supabase Pooler**:
```
DATABASE_URL=postgresql://postgres.xxxxx:password@aws-0-us-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true
```
El puerto `6543` es el Transaction Pooler de Supabase + `?pgbouncer=true` para modo transaccional.

### 8.4 Scripts package.json
```json
{
  "scripts": {
    "dev": "nodemon index.js",
    "start": "node index.js",
    "db:init": "psql \"$DATABASE_URL\" < db/init.sql",
    "db:rls": "psql \"$DATABASE_URL\" < db/rls.sql",
    "db:seed": "psql \"$DATABASE_URL\" < db/seed.sql"
  }
}
```

---

## 9. Consideraciones Adicionales

### 9.1 Vercel Serverless + Conexiones DB
- Usar **Supabase Pooler** (Transaction mode) para manejar conexiones efímeras
- Configurar `connectionTimeoutMillis: 5000` en Pool
- No usar `pool.connect()` en el módulo (solo bajo demanda en cada request)
- Pool con `max: 5` para Vercel (más que suficiente para serverless)

### 9.2 Manejo de Fechas
- Todas las fechas en `DATE` (sin hora, solo día)
- Validar que `fecha_entrada >= CURRENT_DATE`
- Validar que `fecha_salida > fecha_entrada`
- No permitir reservas con más de 30 noches (opcional)

### 9.3 Prevención de Doble Reserva
- Usar la función `habitacion_disponible()` en el controller de crear reserva
- Hacer el check dentro de una transacción para race conditions
- Indexar `(habitacion_id, fecha_entrada, fecha_salida)` como redundancia

### 9.4 Logging Inmutable
- `HistorialReserva` es INSERT-only
- Cliente no puede modificar ni eliminar entradas del historial
- Cada cambio de estado en reserva genera un registro automático
- Se registra la IP origen para auditoría

### 9.5 Admin por Defecto
- El admin se identifica por su email (configurado en `ADMIN_EMAIL` env)
- Al hacer login, si el email coincide → role: 'admin' en el JWT
- El admin no se registra como cliente normal, se configura via env
- Opcional: admin seed en DB con tabla Admin separada

---

## 10. Resumen de Archivos — Checklist ✅

- [x] `package.json`
- [x] `.env.example`
- [x] `vercel.json`
- [x] `docker-compose.yml`
- [x] `db/pool.js`
- [x] `db/index.js`
- [x] `db/cache.js`
- [x] `db/init.sql`
- [x] `db/rls.sql`
- [x] `db/seed.sql`
- [x] `middlewares/auth.middleware.js`
- [x] `middlewares/validator.js`
- [x] `middlewares/errorHandler.js`
- [x] `middlewares/rateLimiter.js`
- [x] `middlewares/sanitize.js`
- [x] `controllers/auth.controller.js`
- [x] `controllers/hotel.controller.js`
- [x] `controllers/habitacion.controller.js`
- [x] `controllers/reserva.controller.js`
- [x] `controllers/cliente.controller.js`
- [x] `controllers/admin.controller.js`
- [x] `controllers/mp.controller.js`
- [x] `routes/auth.route.js`
- [x] `routes/hotel.route.js`
- [x] `routes/habitacion.route.js`
- [x] `routes/reserva.route.js`
- [x] `routes/cliente.route.js`
- [x] `routes/admin.route.js`
- [x] `routes/mp.route.js`
- [x] `utils/generateCode.js`
- [x] `utils/response.js`
- [x] `helpers/whatsappHelper.js`
- [x] `socket/socket.js`
- [x] `index.js`

---

## 11. Guía Frontend — Angular

### 11.1 Estructura de Carpetas

```
src/app/
├── core/                          # Servicios singleton, guards, interceptors, modelos
│   ├── services/
│   │   ├── auth.service.ts        # Login, register, logout, getToken, isLoggedIn
│   │   ├── hotel.service.ts       # GET/PUT /api/hotel
│   │   ├── habitacion.service.ts  # GET /api/habitaciones, /:id, /disponibles
│   │   ├── reserva.service.ts     # POST /api/reservas, GET /mis-reservas, PUT /:id/cancelar
│   │   ├── cliente.service.ts     # GET/PUT /api/clientes/:id
│   │   ├── admin.service.ts       # Dashboard, reservas, clientes, historial, habitaciones CRUD
│   │   └── notification.service.ts # Socket.io — nueva-reserva, reserva-actualizada
│   │
│   ├── guards/
│   │   ├── auth.guard.ts          # Redirige a /login si no hay token
│   │   └── admin.guard.ts         # Redirige a / si no es admin
│   │
│   ├── interceptors/
│   │   └── auth.interceptor.ts    # Adjunta token x-access-token a cada request
│   │
│   └── models/
│       ├── api-response.model.ts  # { status: '1'|'0', msg: string, data: T }
│       ├── hotel.model.ts
│       ├── habitacion.model.ts
│       ├── cliente.model.ts
│       ├── reserva.model.ts
│       └── historial.model.ts
│
├── shared/                        # Componentes y pipes reutilizables
│   ├── components/
│   │   ├── navbar/
│   │   ├── footer/
│   │   ├── loader/
│   │   └── toast/
│   └── pipes/
│       └── currency-ar.pipe.ts    # Formato pesos argentinos
│
├── features/                      # Módulos por feature
│   ├── public/
│   │   ├── home/                  # Landing page del hotel
│   │   ├── habitaciones/
│   │   │   ├── habitacion-list/       # Listado con filtros
│   │   │   ├── habitacion-detail/     # Detalle de una habitación
│   │   │   └── habitacion-buscar/     # Selector de fechas + resultados
│   │   └── reserva/
│   │       ├── reserva-form/          # Formulario de reserva (público)
│   │       └── reserva-exitosa/       # Confirmación con código JAR-XXXXXX
│   │
│   ├── auth/
│   │   ├── login/
│   │   ├── register/
│   │   └── change-password/
│   │
│   ├── cliente/
│   │   ├── perfil/               # Ver/editar perfil
│   │   └── mis-reservas/         # Historial de reservas del cliente
│   │
│   └── admin/
│       ├── dashboard/            # Estadísticas con gráficos
│       ├── habitaciones/
│       │   ├── habitacion-list/      # Listado admin (con editar/eliminar)
│       │   └── habitacion-form/      # Crear/editar habitación
│       ├── reservas/
│       │   ├── reserva-list/         # Todas las reservas (filtros, paginación)
│       │   └── reserva-detail/       # Detalle + cambiar estado
│       ├── clientes/
│       │   ├── cliente-list/         # Todos los clientes
│       │   └── cliente-detail/       # Detalle cliente + sus reservas
│       └── historial/                # Log de todos los cambios
│
├── app.component.ts
├── app.routes.ts
└── app.config.ts
```

### 11.2 Modelos TypeScript

```typescript
// models/api-response.model.ts
export interface ApiResponse<T> {
  status: '1' | '0';
  msg: string;
  data: T;
}

// models/hotel.model.ts
export interface Hotel {
  id: number;
  nombre: string;
  direccion: string;
  telefono: string;
  email: string;
  descripcion: string;
}

// models/habitacion.model.ts
export interface Habitacion {
  id: number;
  numero: number;
  nombre: string;
  descripcion: string;
  camas_individuales: number;
  camas_matrimoniales: number;
  capacidad_max: number;
  tipo: 'Doble' | 'Triple' | 'Cuádruple';
  precio_noche: number;
  activa: boolean;
}

// models/cliente.model.ts
export interface Cliente {
  id: number;
  nombre: string;
  apellido: string;
  telefono: string;
  email: string;
  created_at: string;
}

// models/reserva.model.ts
export interface Reserva {
  id: number;
  codigo: string;
  cliente_id: number;
  habitacion_id: number;
  fecha_entrada: string;
  fecha_salida: string;
  huespedes: number;
  precio_total: number;
  estado: 'Pendiente' | 'Confirmada' | 'Cancelada' | 'Completada';
  notas: string;
  habitacion_numero?: number;
  habitacion_nombre?: string;
  tipo?: string;
  cliente_nombre?: string;
  cliente_apellido?: string;
  cliente_email?: string;
}
```

### 11.3 Servicios Angular — Qué consume cada uno

| Service | Método | Endpoint | Auth |
|---------|--------|----------|------|
| **AuthService** | POST | `/api/auth/register` | No |
| | POST | `/api/auth/login` | No |
| | PUT | `/api/auth/password` | JWT |
| **HotelService** | GET | `/api/hotel` | No |
| | PUT | `/api/hotel` | JWT Admin |
| **HabitacionService** | GET | `/api/habitaciones` | No |
| | GET | `/api/habitaciones/:id` | No |
| | GET | `/api/habitaciones/disponibles?desde=&hasta=` | No |
| **ReservaService** | POST | `/api/reservas` | No |
| | GET | `/api/reservas/mis-reservas` | JWT |
| | GET | `/api/reservas/:id` | JWT |
| | PUT | `/api/reservas/:id/cancelar` | JWT |
| **ClienteService** | GET | `/api/clientes/:id` | JWT |
| | PUT | `/api/clientes/:id` | JWT |
| **AdminService** | GET | `/api/admin/dashboard` | JWT Admin |
| | GET | `/api/admin/reservas` | JWT Admin |
| | PUT | `/api/admin/reservas/:id/estado` | JWT Admin |
| | GET | `/api/admin/clientes` | JWT Admin |
| | GET | `/api/admin/clientes/:id` | JWT Admin |
| | GET | `/api/admin/historial` | JWT Admin |
| | POST | `/api/admin/habitaciones` | JWT Admin |
| | PUT | `/api/admin/habitaciones/:id` | JWT Admin |
| | DELETE | `/api/admin/habitaciones/:id` | JWT Admin |
| **NotificationService** | Socket | `nueva-reserva` | — |
| | Socket | `reserva-actualizada` | — |

### 11.4 Auth Interceptor

```typescript
// core/interceptors/auth.interceptor.ts
import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.getToken();

  if (token) {
    req = req.clone({
      setHeaders: { 'x-access-token': token }
    });
  }

  return next(req);
};
```

### 11.5 Guards

```typescript
// core/guards/auth.guard.ts
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isLoggedIn()) {
    return true;
  }

  return router.createUrlTree(['/login']);
};

// core/guards/admin.guard.ts
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const adminGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isLoggedIn() && authService.isAdmin()) {
    return true;
  }

  return router.createUrlTree(['/']);
};
```

### 11.6 Rutas

```typescript
// app.routes.ts
import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  // Públicas
  { path: '', loadComponent: () => import('./features/public/home/home.component').then(m => m.HomeComponent) },
  { path: 'habitaciones', loadComponent: () => import('./features/public/habitaciones/habitacion-list/habitacion-list.component').then(m => m.HabitacionListComponent) },
  { path: 'habitaciones/:id', loadComponent: () => import('./features/public/habitaciones/habitacion-detail/habitacion-detail.component').then(m => m.HabitacionDetailComponent) },
  { path: 'reserva', loadComponent: () => import('./features/public/reserva/reserva-form/reserva-form.component').then(m => m.ReservaFormComponent) },
  { path: 'reserva/exito/:codigo', loadComponent: () => import('./features/public/reserva/reserva-exitosa/reserva-exitosa.component').then(m => m.ReservaExitosaComponent) },

  // Auth
  { path: 'login', loadComponent: () => import('./features/auth/login/login.component').then(m => m.LoginComponent) },
  { path: 'register', loadComponent: () => import('./features/auth/register/register.component').then(m => m.RegisterComponent) },
  { path: 'cambiar-password', loadComponent: () => import('./features/auth/change-password/change-password.component').then(m => m.ChangePasswordComponent), canActivate: [authGuard] },

  // Cliente
  { path: 'mi-perfil', loadComponent: () => import('./features/cliente/perfil/perfil.component').then(m => m.PerfilComponent), canActivate: [authGuard] },
  { path: 'mis-reservas', loadComponent: () => import('./features/cliente/mis-reservas/mis-reservas.component').then(m => m.MisReservasComponent), canActivate: [authGuard] },

  // Admin
  { path: 'admin', loadComponent: () => import('./features/admin/dashboard/dashboard.component').then(m => m.DashboardComponent), canActivate: [adminGuard] },
  { path: 'admin/habitaciones', loadComponent: () => import('./features/admin/habitaciones/habitacion-list/habitacion-list.component').then(m => m.AdminHabitacionListComponent), canActivate: [adminGuard] },
  { path: 'admin/habitaciones/nueva', loadComponent: () => import('./features/admin/habitaciones/habitacion-form/habitacion-form.component').then(m => m.AdminHabitacionFormComponent), canActivate: [adminGuard] },
  { path: 'admin/habitaciones/:id', loadComponent: () => import('./features/admin/habitaciones/habitacion-form/habitacion-form.component').then(m => m.AdminHabitacionFormComponent), canActivate: [adminGuard] },
  { path: 'admin/reservas', loadComponent: () => import('./features/admin/reservas/reserva-list/reserva-list.component').then(m => m.AdminReservaListComponent), canActivate: [adminGuard] },
  { path: 'admin/reservas/:id', loadComponent: () => import('./features/admin/reservas/reserva-detail/reserva-detail.component').then(m => m.AdminReservaDetailComponent), canActivate: [adminGuard] },
  { path: 'admin/clientes', loadComponent: () => import('./features/admin/clientes/cliente-list/cliente-list.component').then(m => m.AdminClienteListComponent), canActivate: [adminGuard] },
  { path: 'admin/clientes/:id', loadComponent: () => import('./features/admin/clientes/cliente-detail/cliente-detail.component').then(m => m.AdminClienteDetailComponent), canActivate: [adminGuard] },
  { path: 'admin/historial', loadComponent: () => import('./features/admin/historial/historial.component').then(m => m.HistorialComponent), canActivate: [adminGuard] },

  // Fallback
  { path: '**', redirectTo: '' }
];
```

### 11.7 Ejemplo de Servicio

```typescript
// core/services/habitacion.service.ts
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ApiResponse } from '../models/api-response.model';
import { Habitacion } from '../models/habitacion.model';

@Injectable({ providedIn: 'root' })
export class HabitacionService {
  private http = inject(HttpClient);
  private API = 'http://localhost:3000/api';

  getAll(filtros?: { tipo?: string; capacidad_min?: number; precio_max?: number }): Observable<ApiResponse<Habitacion[]>> {
    let params = new HttpParams();
    if (filtros?.tipo) params = params.set('tipo', filtros.tipo);
    if (filtros?.capacidad_min) params = params.set('capacidad_min', filtros.capacidad_min.toString());
    if (filtros?.precio_max) params = params.set('precio_max', filtros.precio_max.toString());
    return this.http.get<ApiResponse<Habitacion[]>>(`${this.API}/habitaciones`, { params });
  }

  getById(id: number): Observable<ApiResponse<Habitacion>> {
    return this.http.get<ApiResponse<Habitacion>>(`${this.API}/habitaciones/${id}`);
  }

  getDisponibles(desde: string, hasta: string): Observable<ApiResponse<Habitacion[]>> {
    const params = new HttpParams().set('desde', desde).set('hasta', hasta);
    return this.http.get<ApiResponse<Habitacion[]>>(`${this.API}/habitaciones/disponibles`, { params });
  }
}
```

### 11.8 Configuración de CORS

El backend acepta conexiones desde `http://localhost:4200` (puerto default de Angular CLI). Si usás otro puerto, actualizá `CORS_ORIGIN` en `.env`:

```env
CORS_ORIGIN=http://localhost:4200,http://localhost:4300
```

### 11.9 Socket.io en Angular

```typescript
// core/services/notification.service.ts
import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private socket: Socket;

  constructor() {
    this.socket = io('http://localhost:3000');
  }

  joinAdmin(): void {
    this.socket.emit('join-admin');
  }

  onNuevaReserva(): Observable<any> {
    return new Observable(observer => {
      this.socket.on('nueva-reserva', data => observer.next(data));
    });
  }

  onReservaActualizada(): Observable<any> {
    return new Observable(observer => {
      this.socket.on('reserva-actualizada', data => observer.next(data));
    });
  }
}
```

---

> **Estado:** Backend completo y subido a GitHub (`ivovicencio/jaquealrey-back`). Crear proyecto Angular con `ng new jaquealrey-front --routing --style=scss` y seguir la guía de la sección 11.
