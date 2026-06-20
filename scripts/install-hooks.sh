#!/bin/sh
# Reinstala los git hooks de Aynimar después de clonar en una máquina nueva.
# Solo toca el repo de backend (Aynimar). Los repos de frontend tienen sus propios hooks.
#
# Uso: sh scripts/install-hooks.sh

HOOKS_DIR="$(git rev-parse --git-dir)/hooks"

echo "Installing Aynimar git hooks → ${HOOKS_DIR}"

# ── pre-commit: smoke tests ────────────────────────────────────────────────────
cat > "${HOOKS_DIR}/pre-commit" << 'EOF'
#!/bin/sh
echo ""
echo "▶ Running Aynimar smoke tests before commit..."
echo ""
node scripts/smoke-test.js
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "🚨 COMMIT BLOCKED — smoke tests failed."
  echo "   Fix the issues above, then re-commit."
  echo "   Emergency bypass (use sparingly): git commit --no-verify"
  echo ""
  exit 1
fi
exit 0
EOF

# ── pre-push: smoke tests (last gate before Railway) ─────────────────────────
cat > "${HOOKS_DIR}/pre-push" << 'EOF'
#!/bin/sh
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null)
REMOTE=$1
echo ""
echo "▶ [pre-push] Branch: ${BRANCH} → remote: ${REMOTE}"
echo "▶ Running smoke tests before push..."
echo ""
node scripts/smoke-test.js
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "🚨 PUSH BLOCKED — smoke tests failed on branch '${BRANCH}'."
  echo "   Railway deploy would have received broken code."
  echo "   Fix the failures above, commit the fix, then push again."
  echo "   Emergency bypass: git push --no-verify"
  echo ""
  exit 1
fi
echo ""
echo "✅ Smoke tests passed — push authorized."
echo ""
exit 0
EOF

chmod +x "${HOOKS_DIR}/pre-commit" "${HOOKS_DIR}/pre-push"
echo "✅ Hooks installed: pre-commit, pre-push"
echo "   Test now: npm run smoke-test"
