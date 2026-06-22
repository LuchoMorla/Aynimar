# Security Policy — Aynimar Backend

**Última actualización:** 2026-06-21
**Responsable:** Luis Morla (luchomorla@gmail.com)

## Reporte de Vulnerabilidades

Para reportar una vulnerabilidad de seguridad, envía un email a **luchomorla@gmail.com** con el asunto `[SECURITY] Aynimar — <descripción breve>`. No abras un issue público.

Tiempo de respuesta esperado: 48 horas.

---

## Estado Actual — CVEs Residuales

`npm audit` reporta **6 vulnerabilidades** en el backend (2 moderate, 4 high). Ninguna es explotable en producción por las razones detalladas a continuación.

### Grupo 1 — `tar` via `@railway/cli` (4 HIGH)

| ID | Severidad | Descripción |
|----|-----------|-------------|
| GHSA-34x7-hfp2-rc4v | High | Arbitrary File Creation/Overwrite via Hardlink Path Traversal |
| GHSA-8qq5-rm4j-mr97 | High | Arbitrary File Overwrite and Symlink Poisoning |
| GHSA-83g3-92jg-28cx | High | Arbitrary File Read/Write via Hardlink Target Escape |
| GHSA-qffp-2rhf-9h96 | High | Hardlink Path Traversal via Drive-Relative Linkpath |

**Cadena de dependencias:** `@railway/cli >= 1.1.2` → `tar <= 7.5.15`

**Por qué no es explotable en producción:**

`@railway/cli` está en `devDependencies`. El archivo `nixpacks.toml` configura el build de Railway con:

```toml
[phases.install]
cmds = ["npm ci --omit=dev"]
```

`npm ci --omit=dev` excluye todas las devDependencies del bundle de producción. `@railway/cli` (y por tanto `tar`) nunca se instala en Railway. Las vulnerabilidades de `tar` son de extracción de archivos — no hay código de extracción de tarballs en producción.

**Fix disponible:** `npm audit fix --force` instalaría `@railway/cli@0.3.1` (breaking change — API CLI incompatible). Decisión: no aplicar, monitoreo pasivo.

---

### Grupo 2 — `uuid` via `sequelize` (2 MODERATE)

| ID | Severidad | Descripción |
|----|-----------|-------------|
| GHSA-w5hq-g745-h8pq | Moderate | Missing buffer bounds check in uuid v3/v5/v6 when `buf` is provided |

**Cadena de dependencias:** `sequelize >= 3.30.1` → `uuid < 11.1.1`

**Por qué no es explotable en producción:**

La vulnerabilidad requiere llamar a `uuid.v3()`, `uuid.v5()` o `uuid.v6()` con un parámetro `buf` controlado por el atacante. Sequelize usa `uuid` internamente para generar IDs de modelos — el `buf` nunca es input externo. No hay endpoint que permita a un usuario controlar cómo Sequelize genera UUIDs internos.

**Fix disponible:** `npm audit fix --force` instalaría `sequelize@3.30.0` (downgrade de v6 a v3 — breaking change masivo). Decisión: no aplicar, monitoreo pasivo.

---

## Historial de Reducción de CVEs

| Fase | Acción | CVEs antes | CVEs después |
|------|--------|-----------|-------------|
| Inicio | — | ~51 | ~51 |
| Fase 2 — audit fix automático | `npm audit fix` (21 CVEs) | ~51 | ~30 |
| Fase 2 — nodemailer → Resend | Eliminación de nodemailer | ~30 | 22 |
| Fase 3 TIER 1 | nodemon 1→3, @railway/cli→devDep, form-data, sequelize, express | 22 | 8 |
| Fase 3 TIER 2 | bcrypt→bcryptjs, multer eliminado | 8 | **6** |

**Reducción total backend:** ~88% (de ~51 a 6)

---

## Sistemas de Protección Activos

En lugar de aplicar breaking changes para cerrar los 6 CVEs residuales, se implementaron controles compensatorios:

1. **Pre-commit hook** — 41 smoke tests bloquean commits con lógica de negocio rota
2. **Pre-push hook** — smoke tests bloquean push si algún test falla
3. **nixpacks.toml `--omit=dev`** — devDependencies nunca llegan a producción Railway
4. **bcryptjs** — migración completa desde `bcrypt` (nativo con cadena tar HIGH)
5. **Auth real** — `bcrypt.compare` activo; login sin bypass desde 2026-06-21 (`2883c60`)
6. **Telegram deploy notifier** — alerta en cada arranque de Railway
7. **Post-deploy health check** — `npm run post-deploy` verifica producción remotamente

---

## Plan de Monitoreo Pasivo

Los 6 CVEs residuales se consideran **aceptados con monitoreo**:

- Revisar `npm audit` en cada actualización de dependencias
- Si `@railway/cli` publica una versión compatible con `tar > 7.5.15`, actualizar
- Si `sequelize` actualiza su dependencia de `uuid` a `>= 11.1.1`, aplicar el upgrade
- No aplicar `npm audit fix --force` sin validar breaking changes en staging primero

**Próximo punto de revisión:** cuando se ejecute Fase 4 (migración de BD o upgrade de Sequelize v7)
