# Security Audit Summary — Fases 2 y 3 (CERRADAS)

**Fecha de cierre Fase 3:** 2026-06-21
**Alcance:** Backend (`Aynimar`) + Panel Admin (`frontDashboardAynimar`)
**Estado:** CERRADA — 10 CVEs residuales aceptados con monitoreo pasivo

---

## Impacto Total (Acumulado Fases 2 + 3)

| Métrica | Antes (Fase 2 inicio) | Después Fase 2 | Después Fase 3 |
|---|---|---|---|
| CVEs backend (`npm audit`) | ~51 | 22 (7 mod, 15 high) | **6** (2 mod, 4 high) |
| CVEs dashboard (`npm audit`) | ~33 | 4 (1 crit, 2 high, 1 mod) | **4** (2 mod, 2 high) |
| **Total combinado** | **~84** | **26** | **10** |
| CVEs críticos | múltiples | 1 (next@12) | **0** |
| Auth bypass activo | desconocido | activo | **eliminado** |
| Dependencias deprecadas | nodemailer, axios@0.27, bcrypt, multer | nodemailer, axios@0.27 | **0** |

---

## Fase 2 — Cambios Aplicados

### Backend — `Aynimar`

| Commit | Acción | CVEs cerrados |
|---|---|---|
| `ecb501b` | `npm audit fix` Phase 1 — parche automático | 21 |
| `992ed00` | Migración `nodemailer` → Resend SDK | 8 |
| `6e0c52b` | Eliminación de `nodeMailer.js` (servicio deprecado) | — |

### Frontend — `frontDashboardAynimar`

| Commit | Acción | CVEs cerrados |
|---|---|---|
| `4712110` | `npm audit fix` Phase 1 — parche automático | 29 |
| `d7cc449` | Upgrade manual `axios@0.27` → `axios@1.17.0` | 2+ |

---

## Fase 3 — Cambios Aplicados

### TIER 1 — Actualización de dependencias backend

| Commit | Acción | CVEs cerrados |
|---|---|---|
| `bf26fd6` | nodemon 1.4.1→3.1.14, @railway/cli→devDeps, form-data 4.0.0→4.0.1, sequelize 6.21.2→6.37.8, express 4.17.1→4.22.2 | 14 |

**Detalle de cambios TIER 1:**

- `nodemon 1.4.1 → 3.1.14` — versión sin CVEs conocidos; movido a devDeps
- `@railway/cli` — movido de `dependencies` a `devDependencies`; excluido de Railway prod vía `nixpacks.toml` (`npm ci --omit=dev`), eliminando toda la cadena `tar` HIGH del bundle de producción
- `form-data 4.0.0 → 4.0.1` — parche menor; CRLF CVE residual tiene riesgo cero (campo names son literales hardcoded en `dropiAdapter.js`)
- `sequelize 6.21.2 → 6.37.8` — cierra múltiples CVEs de versiones intermedias
- `express 4.17.1 → 4.22.2` — cierra CVEs moderados de versiones legacy

### TIER 2 — Eliminación de dependencias problemáticas

| Commit | Acción | CVEs cerrados |
|---|---|---|
| `cf30dde` | `bcrypt` → `bcryptjs`, eliminación de `multer` | 3 |

**Detalle de cambios TIER 2:**

- `bcrypt` eliminado → `bcryptjs@3.0.3` instalado
  - `bcrypt` tiene cadena `node-pre-gyp` → `tar` HIGH; `bcryptjs` es pure-JS sin dependencias nativas
  - API idéntica: `bcrypt.hash()`, `bcrypt.compare()` — mismo formato de hash `$2b$10$...`
  - Compatible con todos los hashes existentes en BD
- `multer` eliminado — dependencia listada en `package.json` pero nunca importada en ningún archivo fuente. Dead dependency confirmada con `grep -r "multer" --include="*.js"`.

### Priority 0 — Corrección de bypass de autenticación

| Commit | Acción | Impacto |
|---|---|---|
| `2883c60` | Restaurar `bcrypt.compare` en `authService.getUser()` | Crítico |

**Detalle:**

`authService.js` tenía `bcrypt.compare` comentado y `const isMatch = true` hardcoded. Cualquier email válido podía autenticarse con cualquier contraseña. El bypass fue introducido en algún punto del desarrollo y nunca revertido.

Fix aplicado:

```javascript
// ANTES (bypass)
// const isMatch = await bcrypt.compare(password, user.password);
const isMatch = true;

// DESPUÉS (fix)
const isMatch = await bcrypt.compare(password, user.password);
if (!isMatch) {
  console.warn(`[auth] Failed login attempt for email: ${email} at ${new Date().toISOString()}`);
  throw boom.unauthorized();
}
```

Los hashes en BD son válidos — el registro siempre usó `bcrypt.hash()` correctamente. Solo la verificación estaba comprometida.

### Fase 3 — Frontend (Next.js 15 Migration)

La migración de Next.js 12 → 15 cerró el CVE crítico del dashboard:

| CVE | Antes | Después |
|-----|-------|---------|
| Critical en next@12.x | Presente | **Eliminado** |
| Total dashboard | 4 (1 crit + 2 high + 1 mod) | **4** (2 high + 2 mod) |

El conteo se mantiene en 4 porque hay CVEs en `form-data/axios` y `postcss/next` que requieren breaking changes para resolverse. Ver `SECURITY.md` del backend y del frontend para detalle.

---

## Sistema de Auto-Validación (activo desde 2026-06-20)

7 capas de calidad que previenen regresiones en producción:

1. **Pre-commit** — 41 smoke tests bloquean commit si falla lógica de negocio
2. **Pre-push × 3 repos** — build/smoke tests bloquean push si falla compilación
3. **Copy quality guard** — `validateCopyOutput()` rechaza bracket leaks y outputs vacíos de IA
4. **SSE quality_warning** — endpoint neuro-copy emite evento si copy es inválido
5. **Dispatch pre-flight** — `_validateDispatchItems()` bloquea despachos con datos corruptos
6. **Deploy health notifier** — Telegram alerta en cada arranque de Railway
7. **Post-deploy remote check** — `npm run post-deploy` verifica producción remotamente

---

## CVEs Residuales Aceptados

| Repo | CVEs | Tipo | Por qué no se aplica el fix |
|------|------|------|----------------------------|
| Backend | 4 high | `tar` via `@railway/cli` (devDep) | devDep excluida de prod; no hay extracción de tarballs en runtime |
| Backend | 2 moderate | `uuid` via `sequelize` | Fix requiere downgrade sequelize v6→v3; uuid usado solo internamente por ORM |
| Frontend | 2 high | `form-data` via `axios` | Fix requiere axios@0.26.1 (downgrade); field names son literales hardcoded |
| Frontend | 2 moderate | `postcss` via `next` | Fix requiere next@9.3.3 (downgrade masivo); solo afecta build-time CSS |

Detalle técnico completo en `Aynimar/SECURITY.md`.

---

## Commits de Referencia (verificados en GitHub)

| Repo | Commit | Descripción |
|------|--------|-------------|
| `LuchoMorla/Aynimar` | `2883c60` | fix(auth): restore real password verification |
| `LuchoMorla/Aynimar` | `cf30dde` | security(tier2): bcrypt→bcryptjs, remove multer |
| `LuchoMorla/Aynimar` | `bf26fd6` | security(tier1): reduce backend CVEs 22→8 |
| `LuchoMorla/frontDashboardAynimar` | `ef4a106` | feat(phase4-ola3c): migrate importar-dropi — migration complete |
| `LuchoMorla/frontDashboardAynimar` | `f821569` | feat(phase3): migrate /login to Next.js 15 App Router |

Deploy automático activo: Railway (backend) y Vercel (dashboard) triggered en cada push a `main`.
