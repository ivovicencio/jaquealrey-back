# AVANCES — Hotel Jaque al Rey API

> Proyecto: jaquealrey-back
> Fecha: Julio 2026
> Estado: Backend completo y subido a GitHub. Pendiente integrar WhatsApp API y MercadoPago API.

---

## ESTADO ACTUAL

- **Backend:** 13 fases implementadas, ~36 archivos, todos los bugs corregidos
- **DB:** Docker con PostgreSQL 15, seed cargado, RLS activo
- **Seguridad:** 8 capas de protección, 3 bugs críticos corregidos
- **Pendiente:** Integrar WhatsApp API y MercadoPago API (credenciales del usuario)
- **Siguiente paso:** Crear proyecto Angular y consumir la API

---

## FASE 1: Inicialización del proyecto

**Archivos creados:**
- `package.json` — Express 5, pg, JWT, bcryptjs, helmet, cors, compression, express-rate-limit, ioredis, socket.io, axios, nodemon
- `.env` / `.env.example` — Variables de entorno (DB, JWT, CORS, Redis, Admin, WhatsApp, MP)
- `docker-compose.yml` — PostgreSQL 15 + Redis 7 + pgAdmin
- `.gitignore` — Excluye .env, node_modules, _test_db.js, _test_script.ps1
- `vercel.json` — Config de deploy

**Estructura de carpetas:** `controllers/`, `routes/`, `middlewares/`, `db/`, `utils/`, `helpers/`, `socket/`

---

## FASE 2: Base de datos

**db/init.sql — Schema completo + tuning para 1000 usuarios concurrentes:**
- 5 tablas: `Hotel`, `Habitacion`, `Cliente`, `Reserva`, `HistorialReserva`
- Índice **GIST** con `daterange` para solapamiento de fechas (optimiza disponibilidad)
- Índices compuestos: `tipo+activa`, `estado+fechas`, `cliente_email LOWER`
- Función `habitacion_disponible()` — check de disponibilidad
- Función `habitaciones_disponibles_en_rango()` — devuelve IDs libres en rango
- Función `buscar_cliente_por_email()` — SECURITY DEFINER (bypass RLS para lookup público)
- Trigger `set_updated_at` en Reserva

**db/rls.sql — Row Level Security:**
- Roles: `app_public`, `app_admin`
- Políticas por tabla: SELECT público solo si `activa=true`, INSERT público permitido, UPDATE/DELETE solo admin
- Cliente: SELECT propio o admin, INSERT público, UPDATE propio o admin
- Reserva: SELECT propia o admin, INSERT público, UPDATE solo admin

**db/seed.sql — Datos iniciales:**
- Hotel: "Jaque al Rey" — Piedra del Águila, Neuquén
- 10 habitaciones (3 Doble $60k, 4 Triple $70k, 3 Cuádruple $80k)

**db/pool.js:** Pool PostgreSQL (max: 20, idle: 30s, timeout: 5s)

**db/index.js:** `executeQuery()` con RLS — setea `app.role` y `app.user_id` vía `SELECT set_config()` parametrizado

**db/cache.js:** Redis wrapper con degradación graceful (si Redis no está, opera sin cache)

---

## FASE 3: Middlewares

**middlewares/auth.middleware.js:**
- `verifyToken` — Lee token de `x-access-token` o `Authorization: Bearer`, verifica JWT, setea `req.userId`, `req.userEmail`, `req.role`
- `verifyAdmin` — Rechaza si `req.role !== 'admin'`

**middlewares/validator.js:**
- Validación por schemas: `required`, `type` (string, number, email, date), `minLength`, `maxLength`, `min`, `max`, `enum`, `pattern`

**middlewares/sanitize.js:**
- Limpia `req.body`, `req.query`, `req.params`: elimina tags HTML y caracteres peligrosos (`'"<>`)

**middlewares/errorHandler.js:**
- Captura códigos PostgreSQL: 23505 (duplicado → 409), 23503 (FK → 400), 22P02 (tipo inválido → 400)
- En producción, no expone stack traces

**middlewares/rateLimiter.js:**
- `globalLimiter`: 200 req/15min por IP
- `loginLimiter`: 10 req/15min
- `registerLimiter`: 5 req/hora
- `reservaLimiter`: 20 req/15min
- `adminLimiter`: 60 req/15min
- `userLimiter`: 30 req/min por userId (o por IP si no autenticado)

---

## FASE 4: Entry point (index.js)

- Compression → Helmet (CSP, HSTS, noSniff, frameguard, referrerPolicy) → CORS (whitelist configurable, sin wildcard en prod) → JSON parser (1mb) → URL-encoded parser → Sanitize → Rate limit global
- Validación de entorno al arranque: `JWT_SECRET` (min 32 chars), `DATABASE_URL`, `CORS_ORIGIN` en producción
- `app.disable('x-powered-by')` — no exponer tecnología
- Servidor HTTP con Socket.io integrado
- Graceful shutdown: SIGTERM/SIGINT → cierra HTTP → cierra Redis → cierra pool PostgreSQL (timeout 10s)

---

## FASE 5: Módulo Hotel

**controllers/hotel.controller.js + routes/hotel.route.js:**
- `GET /api/hotel` — Público, obtiene info del hotel (cacheable en Redis)
- `PUT /api/hotel` — Admin, actualiza info del hotel

---

## FASE 6: Módulo Auth

**controllers/auth.controller.js + routes/auth.route.js:**
- `POST /api/auth/register` — Crea cliente, bcrypt salt=12, JWT 24h, valida password (mayúsc+minúsc+núm, >=8 chars). Si `ADMIN_SECRET` está configurado, requiere `admin_secret` en el body para registrarse como admin
- `POST /api/auth/login` — Login por email, bcrypt compare, JWT con role
- `PUT /api/auth/password` — Cambio de password (requiere auth + password actual + password nueva)
- Admin se identifica por `ADMIN_EMAIL` env var + `ADMIN_SECRET`

---

## FASE 7: Módulo Habitaciones

**controllers/habitacion.controller.js + routes/habitacion.route.js:**
- `GET /api/habitaciones` — Público, filtros: tipo, capacidad_min, precio_max, disponible_desde/hasta
- `GET /api/habitaciones/:id` — Público, detalle de habitación
- `GET /api/habitaciones/disponibles` — Público, habitaciones libres en rango de fechas
- `POST /api/admin/habitaciones` — Admin, crear habitación
- `PUT /api/admin/habitaciones/:id` — Admin, actualizar
- `DELETE /api/admin/habitaciones/:id` — Admin, eliminar (solo sin reservas activas)

---

## FASE 8: Módulo Reservas

**controllers/reserva.controller.js + routes/reserva.route.js:**
- `POST /api/reservas` — Público, crea reserva (busca cliente por email o lo auto-registra con pass temporal, verifica disponibilidad en transacción, calcula precio_total por noches, genera código JAR-XXXXXX, registra en HistorialReserva)
- `GET /api/reservas/mis-reservas` — Autenticado, historial del cliente
- `GET /api/reservas/:id` — Autenticado, detalle (propia o admin)
- `PUT /api/reservas/:id/cancelar` — Autenticado, cancela (dueño o admin)

**utils/generateCode.js:** Código `JAR-XXXXXX` con `crypto.randomBytes`

**utils/response.js:** Helpers `success()` y `error()` con formato unificado `{ status, msg, data }`

---

## FASE 9: Módulo Clientes

**controllers/cliente.controller.js + routes/cliente.route.js:**
- `GET /api/clientes/:id` — Autenticado, perfil (propio o admin)
- `PUT /api/clientes/:id` — Autenticado, actualizar (propio o admin)

---

## FASE 10: Módulo Admin

**controllers/admin.controller.js + routes/admin.route.js:**
- `GET /api/admin/dashboard` — Estadísticas (activas, próximas 7 días, ingresos del mes, total clientes, habitaciones activas)
- `GET /api/admin/reservas` — Lista paginada con filtros (estado, desde, hasta)
- `PUT /api/admin/reservas/:id/estado` — Cambia estado + log en HistorialReserva
- `GET /api/admin/clientes` — Lista paginada
- `GET /api/admin/clientes/:id` — Detalle con reservas del cliente
- `GET /api/admin/historial` — Log completo de cambios

---

## FASE 11: Notificaciones en tiempo real (Socket.io)

**socket/socket.js:**
- Sala `admins` — tanto recepcionista como dueño reciben notificaciones
- Evento `nueva-reserva` — cuando un cliente crea una reserva
- Evento `reserva-actualizada` — cuando admin cambia estado o cliente cancela

---

## FASE 12: WhatsApp API

**helpers/whatsappHelper.js:**
- `notifyNewReserva()` — envía mensaje al `ADMIN_WHATSAPP` con código, datos del cliente, habitación, fechas y total
- Integrado en `reserva.controller.js` (se dispara al crear reserva)
- Configurable via `.env`: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `ADMIN_WHATSAPP`
- **PENDIENTE:** Configurar credenciales de WhatsApp Cloud API

---

## FASE 13: MercadoPago

**controllers/mp.controller.js + routes/mp.route.js:**
- `POST /api/pagos/crear-preferencia` — Crea preferencia de pago MP (autenticado)
- `POST /api/pagos/webhook` — Webhook que confirma la reserva cuando se aprueba el pago
- `GET /api/pagos/success` — Redirect post-pago exitoso
- `GET /api/pagos/pending` — Redirect post-pago pendiente
- `GET /api/pagos/failure` — Redirect post-pago fallido
- Cambia estado a `Confirmada` y registra en `HistorialReserva`
- Configurable via `.env`: `MP_ACCESS_TOKEN`, `BASE_URL`
- **PENDIENTE:** Configurar credenciales de MercadoPago

---

## SEGURIDAD IMPLEMENTADA

| Capa | Qué se hizo |
|------|------------|
| **Helmet** | CSP, HSTS, noSniff, frameguard deny, referrer-policy no-referrer |
| **CORS** | Lista blanca configurable, sin wildcard en producción |
| **Rate Limiting** | 6 limiters por IP y por usuario |
| **JWT** | Token 24h, verificación en middleware, role admin/cliente |
| **Input sanitization** | Elimina HTML y caracteres peligrosos (`'"<>`) de body/query/params |
| **Validación** | Schemas con tipo, enum, minLength, pattern |
| **SQL parametrizado** | 100% queries con `$1, $2` — cero concatenación |
| **RLS forzado** | `executeQuery()` siempre setea `app.role` y `app.user_id` via `set_config()` |
| **Bcrypt salt=12** | Passwords hasheadas con 12 rondas |
| **ADMIN_SECRET** | Registro como admin protegido por secret configurable |
| **Cambio de password** | Endpoint seguro que requiere password actual |
| **No leak** | Error handler no expone stack traces en producción |
| **Graceful shutdown** | Cierre ordenado con timeout forzado |
| **Docker tuning** | PostgreSQL configurado para 1000 concurrentes |

---

## BUGS CORREGIDOS (Julio 2026)

### Bug CRÍTICO — DB: `SET LOCAL` no soporta params
- **Archivo:** `db/index.js`
- **Problema:** `SET LOCAL app.role = $1` lanza `syntax error at or near "$1"` — PostgreSQL no acepta placeholders en `SET`.
- **Fix:** Reemplazado por `SELECT set_config('app.role', $1, true)` (mismo efecto, parametrizado).
- **Impacto:** Sin este fix, **ningún endpoint que usara `executeQuery()` funcionaba**.

### Bug ALTO — DELETE habitaciones sin check real de reservas
- **Archivo:** `controllers/habitacion.controller.js:144`
- **Problema:** `hasReservas` se ejecutaba sin `{ role: "admin" }`, así que RLS filtraba y siempre devolvía 0 filas. Se podía borrar habitaciones con reservas activas.
- **Fix:** Agregado `{ role: "admin" }` como tercer argumento a `executeQuery`.

### Bug MEDIO — Sanitizer corrompía passwords con `$`
- **Archivo:** `middlewares/sanitize.js`
- **Problema:** El regex eliminaba `$` de todos los inputs. Un password como `P@ss$word` se guardaba como `P@ssword`.
- **Fix:** Removido `$` y `\` del pattern de strip. Solo limpia `'"<>` y tags HTML.

### Stub temporal
- `GET /api/admin/reservas/:id` llama a `getReservas` que ignora el `:id`. No rompe nada.

---

## ENDPOINTS COMPLETOS

### Públicos (sin auth)
| Método | Ruta | Rate Limit |
|--------|------|------------|
| GET | `/` | 200/15min |
| GET | `/api/hotel` | 200/15min |
| GET | `/api/habitaciones` | 200/15min |
| GET | `/api/habitaciones/:id` | 200/15min |
| GET | `/api/habitaciones/disponibles?desde=&hasta=` | 200/15min |
| POST | `/api/auth/register` | 5/hora |
| POST | `/api/auth/login` | 10/15min |
| POST | `/api/reservas` | 20/15min |

### Protegidas (JWT)
| Método | Ruta |
|--------|------|
| PUT | `/api/auth/password` |
| GET | `/api/reservas/mis-reservas` |
| GET | `/api/reservas/:id` |
| PUT | `/api/reservas/:id/cancelar` |
| GET | `/api/clientes/:id` |
| PUT | `/api/clientes/:id` |

### Admin (JWT + admin)
| Método | Ruta |
|--------|------|
| PUT | `/api/hotel` |
| GET | `/api/admin/dashboard` |
| GET | `/api/admin/reservas` |
| PUT | `/api/admin/reservas/:id/estado` |
| GET | `/api/admin/clientes` |
| GET | `/api/admin/clientes/:id` |
| GET | `/api/admin/historial` |
| POST | `/api/admin/habitaciones` |
| PUT | `/api/admin/habitaciones/:id` |
| DELETE | `/api/admin/habitaciones/:id` |

### Pagos
| Método | Ruta |
|--------|------|
| POST | `/api/pagos/crear-preferencia` |
| POST | `/api/pagos/webhook` |
| GET | `/api/pagos/success` |
| GET | `/api/pagos/pending` |
| GET | `/api/pagos/failure` |

---

> **Estado:** Backend completo y subido a GitHub (repo: `ivovicencio/jaquealrey-back`). Docker corriendo con PostgreSQL 15 + Redis 7. Listo para crear el proyecto Angular y consumir la API.
