#!/usr/bin/env bash
# tests/install-idempotency.sh
#
# Smoke test for install.sh / uninstall.sh against a fully sandboxed fake
# HOME — never touches the real ~/.omp, ~/.claude, or ~/.agent-flywheel.
# Verifies:
#   1. install.sh wires omp (extension + rules + config.yml advisor: block)
#      and Claude Code (settings.json hooks), without clobbering pre-existing
#      content it doesn't own (modelRoles:, existingKey, WATCHDOG.*).
#   2. Running install.sh a second time does not duplicate anything
#      (idempotency) — exactly one advisor: block, exactly one hook entry
#      per Claude Code event.
#   3. uninstall.sh --purge fully reverses every change and removes
#      ~/.agent-flywheel, restoring pre-existing content untouched.
#
# Exit code 0 = all checks passed. Any failure prints which check failed
# and exits non-zero (set -e propagates from the `fail` helper).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$FAKE_HOME"' EXIT

FAIL=0
check() {
  local desc="$1" cond="$2"
  if [ "$cond" = "0" ]; then
    printf '  \033[32m✓\033[0m %s\n' "$desc"
  else
    printf '  \033[31m✗\033[0m %s\n' "$desc"
    FAIL=1
  fi
}

mkdir -p "$FAKE_HOME/.omp/agent" "$FAKE_HOME/.claude"
cat > "$FAKE_HOME/.omp/agent/config.yml" <<'YAML'
modelRoles:
  default: anthropic/claude-sonnet-5
YAML
echo '{"existingKey": true}' > "$FAKE_HOME/.claude/settings.json"

echo "=== install.sh (first run) ==="
HOME="$FAKE_HOME" "$ROOT_DIR/install.sh" --home "$FAKE_HOME/.agent-flywheel"

check "extension copied" "$([ -f "$FAKE_HOME/.omp/agent/extensions/agent-flywheel-self-improvement-loop.ts" ] && echo 0 || echo 1)"
check "rules copied" "$([ -f "$FAKE_HOME/.omp/agent/rules/agent-flywheel-todo-continuation-enforcer.md" ] && [ -f "$FAKE_HOME/.omp/agent/rules/agent-flywheel-comment-checker.md" ] && echo 0 || echo 1)"
check "config.yml keeps pre-existing modelRoles" "$(grep -q 'default: anthropic/claude-sonnet-5' "$FAKE_HOME/.omp/agent/config.yml" && echo 0 || echo 1)"
check "config.yml gained exactly one advisor: block" "$([ "$(grep -c 'agent-flywheel: advisor >>>' "$FAKE_HOME/.omp/agent/config.yml")" = "1" ] && echo 0 || echo 1)"
check "settings.json kept pre-existing existingKey" "$(python3 -c "import json;print(0 if json.load(open('$FAKE_HOME/.claude/settings.json')).get('existingKey') is True else 1)")"
check "settings.json has exactly one SessionStart hook" "$(python3 -c "import json;d=json.load(open('$FAKE_HOME/.claude/settings.json'));print(0 if len(d['hooks']['SessionStart'])==1 else 1)")"
check "settings.json has exactly one SessionEnd hook" "$(python3 -c "import json;d=json.load(open('$FAKE_HOME/.claude/settings.json'));print(0 if len(d['hooks']['SessionEnd'])==1 else 1)")"

echo "=== agent-flywheel doctor / reflect (against the freshly installed HOME) ==="
DOCTOR_OUT="$(AGENT_FLYWHEEL_HOME="$FAKE_HOME/.agent-flywheel" "$ROOT_DIR/bin/agent-flywheel" doctor || true)"
check "doctor reports all checks passed" "$(printf '%s' "$DOCTOR_OUT" | grep -q 'all checks passed' && echo 0 || echo 1)"
check "doctor found FLYWHEEL_HOME" "$(printf '%s' "$DOCTOR_OUT" | grep -q 'FLYWHEEL_HOME exists' && echo 0 || echo 1)"

REFLECT_OUT="$(AGENT_FLYWHEEL_HOME="$FAKE_HOME/.agent-flywheel" "$ROOT_DIR/bin/agent-flywheel" reflect --harness omp --session /tmp/agent-flywheel-fake-session --print || true)"
check "reflect --print --harness omp emits an omp resume command" "$(printf '%s' "$REFLECT_OUT" | grep -q '^omp -p' && echo 0 || echo 1)"
check "reflect --print --harness omp embeds the session path" "$(printf '%s' "$REFLECT_OUT" | grep -q -- '--resume /tmp/agent-flywheel-fake-session' && echo 0 || echo 1)"

echo "=== install.sh (second run — idempotency) ==="
HOME="$FAKE_HOME" "$ROOT_DIR/install.sh" --home "$FAKE_HOME/.agent-flywheel"

check "config.yml still has exactly one advisor: block after re-run" "$([ "$(grep -c 'agent-flywheel: advisor >>>' "$FAKE_HOME/.omp/agent/config.yml")" = "1" ] && echo 0 || echo 1)"
check "settings.json still has exactly one SessionStart hook after re-run" "$(python3 -c "import json;d=json.load(open('$FAKE_HOME/.claude/settings.json'));print(0 if len(d['hooks']['SessionStart'])==1 else 1)")"
check "settings.json still has exactly one SessionEnd hook after re-run" "$(python3 -c "import json;d=json.load(open('$FAKE_HOME/.claude/settings.json'));print(0 if len(d['hooks']['SessionEnd'])==1 else 1)")"

echo "=== uninstall.sh --purge ==="
HOME="$FAKE_HOME" "$ROOT_DIR/uninstall.sh" --home "$FAKE_HOME/.agent-flywheel" --purge

check "extension removed" "$([ ! -f "$FAKE_HOME/.omp/agent/extensions/agent-flywheel-self-improvement-loop.ts" ] && echo 0 || echo 1)"
check "advisor: block removed, modelRoles: preserved" "$(grep -q 'default: anthropic/claude-sonnet-5' "$FAKE_HOME/.omp/agent/config.yml" && ! grep -q 'agent-flywheel: advisor' "$FAKE_HOME/.omp/agent/config.yml" && echo 0 || echo 1)"
check "settings.json hooks removed, existingKey preserved" "$(python3 -c "import json;d=json.load(open('$FAKE_HOME/.claude/settings.json'));print(0 if d.get('existingKey') is True and len(d['hooks']['SessionStart'])==0 and len(d['hooks']['SessionEnd'])==0 else 1)")"
check "FLYWHEEL_HOME purged" "$([ ! -d "$FAKE_HOME/.agent-flywheel" ] && echo 0 || echo 1)"

echo
if [ "$FAIL" = "0" ]; then
  printf '\033[32mAll install/uninstall idempotency checks passed.\033[0m\n'
  exit 0
else
  printf '\033[31mOne or more install/uninstall idempotency checks failed.\033[0m\n'
  exit 1
fi
