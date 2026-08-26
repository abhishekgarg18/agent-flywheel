#!/usr/bin/env bash
# install.sh — sync agent-flywheel into ~/.agent-flywheel and wire every
# detected harness (omp, Claude Code; Codex CLI and GitHub Copilot CLI get
# printed manual instructions — see "Why Codex/Copilot aren't auto-wired"
# below).
#
# Idempotent: re-running after a `git pull` re-syncs the managed files and
# re-applies config merges without duplicating entries or clobbering
# settings this project doesn't own.
#
# Usage:
#   ./install.sh                 # detect + wire everything found
#   ./install.sh --dry-run       # print what would happen, touch nothing
#   ./install.sh --only omp      # wire a single harness (omp|claude-code)
#   ./install.sh --skip omp      # wire everything except one harness
#   ./install.sh --home <path>   # install somewhere other than ~/.agent-flywheel
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYWHEEL_HOME="${AGENT_FLYWHEEL_HOME:-$HOME/.agent-flywheel}"
DRY_RUN=0
ONLY=""
SKIP=""

info() { printf '\033[34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --home) FLYWHEEL_HOME="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) err "unknown option: $1"; usage >&2; exit 2 ;;
  esac
done

wants() {
  local harness="$1"
  [ -n "$ONLY" ] && [ "$ONLY" != "$harness" ] && return 1
  case ",$SKIP," in *",$harness,"*) return 1 ;; esac
  return 0
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# --- Step 1: sync the repo into FLYWHEEL_HOME -------------------------------
# Every hook script's `source .../core/lib.sh` and `spawn(... "$SESSION_ID")`
# path assumes adapters/ and core/ sit next to each other exactly as they do
# in this checkout, so the whole tree is synced verbatim rather than
# cherry-picking files.
sync_repo() {
  info "Syncing $ROOT_DIR -> $FLYWHEEL_HOME"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] sync repo (excluding .git) into %s\n' "$FLYWHEEL_HOME"
    return 0
  fi
  mkdir -p "$FLYWHEEL_HOME"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '.git' --exclude 'tests' --exclude 'node_modules' \
      "$ROOT_DIR"/ "$FLYWHEEL_HOME"/
  else
    find "$FLYWHEEL_HOME" -mindepth 1 -not -name '.last-periodic-reflection' -not -name 'advisor-autotune.log' -delete 2>/dev/null || true
    (cd "$ROOT_DIR" && tar cf - --exclude='.git' --exclude='tests' --exclude='node_modules' .) | (cd "$FLYWHEEL_HOME" && tar xf -)
  fi
  chmod +x "$FLYWHEEL_HOME/bin/agent-flywheel" \
    "$FLYWHEEL_HOME"/adapters/*/hooks/*.sh 2>/dev/null || true
  ok "Synced to $FLYWHEEL_HOME"
}

# --- Marker-based idempotent text-block merge -------------------------------
# Replaces the content between "# >>> agent-flywheel: $2 >>>" / "<<< ... <<<"
# markers in file $1 with the body read from stdin, appending the marked
# block if it isn't present yet. Safe to call every run: never duplicates,
# never touches content outside its own markers.
merge_marked_block() {
  local file="$1" key="$2"
  local body_file start end
  body_file="$(mktemp)"
  cat > "$body_file"
  start="# >>> agent-flywheel: $key >>>"
  end="# <<< agent-flywheel: $key <<<"
  touch "$file"
  if grep -qF "$start" "$file" 2>/dev/null; then
    awk -v start="$start" -v end="$end" -v bodyfile="$body_file" '
      $0 == start {
        print
        while ((getline line < bodyfile) > 0) print line
        close(bodyfile)
        skip = 1
        next
      }
      $0 == end { skip = 0; print; next }
      !skip { print }
    ' "$file" > "$file.flywheel-tmp"
  else
    cp "$file" "$file.flywheel-tmp"
    { printf '\n%s\n' "$start"; cat "$body_file"; printf '%s\n' "$end"; } >> "$file.flywheel-tmp"
  fi
  mv "$file.flywheel-tmp" "$file"
  rm -f "$body_file"
}

# --- omp adapter -------------------------------------------------------------
wire_omp() {
  local omp_dir="$HOME/.omp/agent"
  [ -d "$omp_dir" ] || { info "omp not found ($omp_dir missing) — skipping"; return 0; }
  info "Wiring omp adapter into $omp_dir"

  run mkdir -p "$omp_dir/extensions" "$omp_dir/rules"
  run cp "$FLYWHEEL_HOME/adapters/omp/extensions/self-improvement-loop.ts" \
    "$omp_dir/extensions/agent-flywheel-self-improvement-loop.ts"
  run cp "$FLYWHEEL_HOME/adapters/omp/rules/todo-continuation-enforcer.md" \
    "$omp_dir/rules/agent-flywheel-todo-continuation-enforcer.md"
  run cp "$FLYWHEEL_HOME/adapters/omp/rules/comment-checker.md" \
    "$omp_dir/rules/agent-flywheel-comment-checker.md"

  # WATCHDOG.md / WATCHDOG.yml are omp-native top-level config a developer
  # may already have customized — never clobber, only seed if absent.
  if [ ! -f "$omp_dir/WATCHDOG.md" ]; then
    run cp "$FLYWHEEL_HOME/adapters/omp/WATCHDOG.md" "$omp_dir/WATCHDOG.md"
  else
    warn "$omp_dir/WATCHDOG.md already exists — not overwritten (see adapters/omp/WATCHDOG.md to compare)"
  fi
  if [ ! -f "$omp_dir/WATCHDOG.yml" ]; then
    run cp "$FLYWHEEL_HOME/adapters/omp/WATCHDOG.yml.example" "$omp_dir/WATCHDOG.yml"
  else
    warn "$omp_dir/WATCHDOG.yml already exists — not overwritten (see adapters/omp/WATCHDOG.yml.example to compare)"
  fi

  # config.yml: idempotent marker-merge of the advisor: block only —
  # never touch modelRoles: or anything else already in the file.
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] merge advisor: block into %s\n' "$omp_dir/config.yml"
  else
    merge_marked_block "$omp_dir/config.yml" "advisor" <<'YAML'
advisor:
  enabled: true
  immuneTurns: 3
  syncBacklog: "off"
YAML
  fi
  ok "omp wired (extension + rules copied; WATCHDOG seeded if absent; config.yml advisor: block merged)"
  warn "Add 'advisor: anthropic/claude-sonnet-5' under your existing modelRoles: map in $omp_dir/config.yml by hand (YAML can't have modelRoles: twice, so this can't be automated safely)"
}

# --- Claude Code adapter ------------------------------------------------------
wire_claude_code() {
  command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ] || { info "Claude Code not found — skipping"; return 0; }
  local settings="$HOME/.claude/settings.json"
  info "Wiring Claude Code hooks into $settings"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] jq-merge SessionStart/SessionEnd hooks into %s\n' "$settings"
    return 0
  fi
  command -v jq >/dev/null 2>&1 || { err "jq is required to wire Claude Code hooks (brew install jq)"; return 1; }
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  local start_cmd="$FLYWHEEL_HOME/adapters/claude-code/hooks/session-start.sh"
  local end_cmd="$FLYWHEEL_HOME/adapters/claude-code/hooks/session-end.sh"
  jq \
    --arg start_cmd "$start_cmd" \
    --arg end_cmd "$end_cmd" \
    '
    .hooks.SessionStart = ((.hooks.SessionStart // []) | map(select((.hooks[0].command // "") != $start_cmd)))
      + [{matcher: "*", hooks: [{type: "command", command: $start_cmd}]}]
    | .hooks.SessionEnd = ((.hooks.SessionEnd // []) | map(select((.hooks[0].command // "") != $end_cmd)))
      + [{matcher: "*", hooks: [{type: "command", command: $end_cmd, timeout: 5}]}]
    ' "$settings" > "$settings.flywheel-tmp"
  mv "$settings.flywheel-tmp" "$settings"
  ok "Claude Code wired ($settings hooks.SessionStart / hooks.SessionEnd)"
}

# --- Codex / Copilot: unverified hook schema, print instructions only -------
# adapters/codex/notes.md and adapters/copilot/notes.md explain why: neither
# CLI's SessionStart-equivalent / background-timer schema was confirmed
# while building this project, and shipping an unverified auto-wire step
# that silently no-ops or writes to the wrong config key is worse than
# printing three lines a human can verify against their installed version.
print_manual_instructions() {
  local harness="$1" notes="$2"
  command -v "$harness" >/dev/null 2>&1 || [ -d "$HOME/.$harness" ] || return 0
  info "$harness found — hook wiring is manual (schema not verified against your version)"
  cat <<EOF
  Session-end script (ready to use):  $FLYWHEEL_HOME/adapters/$harness/hooks/session-end.sh
  Wire it into $harness's own session-end hook config, then check whether
  $harness needs an interactive trust/approval step before it will run a
  newly added hook (Codex CLI does; run it once interactively after wiring).
  Full details, plus the session-start/periodic-checkpoint fallback that
  works with ANY CLI tool today: $notes
EOF
}

# --- Main --------------------------------------------------------------------
main() {
  info "agent-flywheel installer — target: $FLYWHEEL_HOME"
  [ "$DRY_RUN" = "1" ] && info "(dry run — no files will be written)"

  sync_repo

  wants omp && wire_omp
  wants claude-code && wire_claude_code
  wants codex && print_manual_instructions codex "$FLYWHEEL_HOME/adapters/codex/notes.md"
  wants copilot && print_manual_instructions copilot "$FLYWHEEL_HOME/adapters/copilot/notes.md"

  echo
  ok "Done. Any other harness (Cursor, Windsurf, Aider, custom scripts): see adapters/generic/README.md"
  info "Maturity nudge for a harness with no hook system at all: $FLYWHEEL_HOME/bin/agent-flywheel nudge"
}

main "$@"
