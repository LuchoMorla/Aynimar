# Maintenance Guide — Q4 2026

Triggered by Fase 3 CVE cleanup (2026-06-21). Review these items before 2026-12-31.

---

## 1. Sequelize 7 Migration

**When**: After Sequelize 7 stable release (watch https://github.com/sequelize/sequelize/releases).

**Breaking changes to review before upgrading:**

| Area | v6 behavior | v7 change |
|---|---|---|
| Model definitions | `Model.init({ ... }, { sequelize })` | Same API, but `DataTypes` renamed in some dialects |
| Associations | `hasMany` / `belongsTo` as-is | `ForeignKeyConstraint` now defaults to `CASCADE` — verify migrations |
| Query interface | `queryInterface.addColumn` | Some method signatures changed, check migration files |
| Connection pool | `dialectOptions.ssl` top-level | Moved under `pool.dialectOptions` |
| `Op` operators | `[Op.like]` etc. | No change, but string operators fully removed |

**Test checklist before merging Sequelize 7 PR:**
- [ ] `npm run migrations:run` completes without errors on a fresh DB
- [ ] `npm run test` (smoke tests) pass
- [ ] Login, create order, and list products in staging
- [ ] Verify `app_settings` table reads/writes for Dropi token flow

**After upgrading Sequelize 7**, check `package.json` `overrides`:
```json
"overrides": {
  "uuid": ">=11.1.1"
}
```
Run `npm ls uuid` and verify all resolved versions are `>=11.1.1`. If Sequelize 7 ships
a uuid dependency that already meets this constraint, remove the override to reduce
maintenance surface. If it still ships a vulnerable uuid, keep the override.

---

## 2. uuid Override Review

**Current state (2026-06-21):** `"overrides": {"uuid": ">=11.1.1"}` forces uuid past
GHSA-w5hq-g745-h8pq (CVE affecting uuid < 11.1.1). Sequelize 6.37.8 uses uuid
internally for primary keys.

**Review trigger:** Any upgrade of `sequelize` or `pg`.

**How to verify:**
```bash
npm ls uuid              # all entries should be >= 11.1.1
npm audit --audit-level=moderate   # should report 0 vulnerabilities
```

---

## 3. Node 20 → 22 Migration

Railway will eventually deprecate Node 20 LTS. When Node 22 LTS is available:

1. Update `nixpacks.toml`:
   ```toml
   nixPkgs = ["nodejs_22"]
   ```
2. Test locally with `nvm use 22 && npm ci && npm start`
3. Verify uuid v14 CJS shim still loads under Node 22 (`node -e "require('uuid')"`)

---

## 4. Resend SDK Review

Resend is used for transactional email (`libs/resend.js`). Check for breaking changes
if a major version is released. Current: `resend` latest at time of Fase 2 migration.

```bash
npm outdated resend
```

---

## 5. Express 5 Migration

Express 4.22.x is in production. Express 5 removes `res.send(statusCode)` (use
`res.status(code).send()`), async error propagation changes, and Router changes.
Run `npm install express@5 --dry-run` to see what breaks before committing.

---

## 7. Protocolo de Recuperación de Usuario

**Cuándo activar:** Ante cualquiera de estos eventos:
- Sospecha de credenciales comprometidas (logs de `rate_limit_auth` frecuentes desde IPs externas)
- Fuerza bruta confirmada en Railway logs
- Incidente de seguridad externo que afecte proveedores de autenticación
- Auditoría programada de contraseñas (semestral)

**Usuarios clave a notificar primero:**
1. `role = 'admin'` — control total del sistema
2. `role = 'business_owner'` — acceso a datos financieros
3. `role = 'recycler'` — acceso operativo

---

### Paso a paso

**Paso 1 — Identificar usuarios afectados**
```sql
-- En la DB de Railway (pgAdmin o railway run psql)
SELECT id, email, role, "updatedAt"
FROM users
WHERE role IN ('admin', 'business_owner', 'recycler')
ORDER BY role, email;
```
Exportar lista a CSV para tracking.

**Paso 2 — Revocar tokens activos (opcional, ante incidente grave)**

Si el incidente requiere invalidación inmediata: cambiar `JWT_SECRET` en Railway Variables.
Esto invalida TODOS los tokens existentes. Hacerlo solo si hay compromiso confirmado, ya que
desloguea a todos los usuarios simultáneamente.

```bash
# En Railway dashboard → Variables → editar JWT_SECRET → Deploy
# El nuevo valor puede ser: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

**Paso 3 — Enviar email de recuperación**

Usar el endpoint existente para disparar el flujo de recovery por cada usuario afectado:
```bash
# Por cada email de la lista del Paso 1:
curl -X POST https://<BACKEND_URL>/api/v1/auth/recovery \
  -H "Content-Type: application/json" \
  -d '{"email": "usuario@ejemplo.com"}'
```

O bien usar un script batch:
```js
// scripts/force-recovery.js — ejecutar solo en emergencia
const emails = ['admin@aynimar.com', 'owner@ejemplo.com'];
for (const email of emails) {
  await fetch(`${process.env.BACKEND_URL}/api/v1/auth/recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  console.log(`Recovery enviado a: ${email}`);
}
```

**Paso 4 — Notificación por Telegram al dueño**

El sistema enviará automáticamente señal de alerta si hay rate limiting disparado
(`rate_limit_auth` en Railway logs). Para notificación manual adicional:
```bash
# Mensaje directo al chat del dueño
curl -X POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "'$TELEGRAM_OWNER_ID'", "text": "⚠️ ALERTA: Protocolo de recuperación activado. Se enviaron emails de reset a N usuarios clave.", "parse_mode": "HTML"}'
```

**Paso 5 — Deadline y seguimiento**

- Dar **48 horas** a los usuarios para completar el reset.
- A las 24 h: reenviar el email con asunto "Recordatorio urgente — reactiva tu acceso".
- A las 48 h: cuentas sin reset → bloquear manualmente en DB (`active = false`) o contacto directo.

```sql
-- Verificar quién completó el reset (password actualizado después del incidente)
SELECT email, role, "updatedAt"
FROM users
WHERE role IN ('admin', 'business_owner', 'recycler')
  AND "updatedAt" > '2026-XX-XX 00:00:00'  -- reemplazar con fecha del incidente
ORDER BY "updatedAt" DESC;
```

**Paso 6 — Post-mortem**

Registrar en `docs/SECURITY_AUDIT_SUMMARY.md`:
- Fecha y causa del incidente
- Número de usuarios notificados / que completaron reset
- Cambios implementados para prevenir recurrencia

---

## 6. Structured Logger Upgrade (Optional)

`libs/logger.js` is a zero-dependency JSON logger. If log volume grows and you need
sampling, async writes, or transport plugins, migrate to `pino`:

```bash
npm install pino pino-pretty
```

Swap in `libs/logger.js`:
```js
const pino = require('pino');
module.exports = pino({ level: process.env.LOG_LEVEL || 'info' });
```

The call signature (`log.info(msg, data)`) is compatible — pino's signature is
`logger.info(data, msg)`, so invert the argument order at each call site.
