// tests/lib-safety.test.mjs
// Security + safety regressions for core/lib.sh helpers added with the
// self-improving/config work: the config loader must never execute file
// content (it runs at source time on every hook), flywheel_path_trusted must
// fail closed on non-owned/writable paths (it gates `doctor --heal`'s exec of a
// recorded checkout), the CLI-path note must resolve to this install's bin, and
// mode=days must not re-fire once per day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const LIB = join(REPO_ROOT, "core", "lib.sh");

// Source lib.sh in a fresh bash and run `script`, returning stdout. Never
// throws for non-zero (callers assert on output / side effects).
function bash(script, { home, env = {} } = {}) {
  const h = home ?? mkdtempSync(join(tmpdir(), "af-lib-"));
  try {
    return execFileSync("bash", ["-c", `source "${LIB}"\n${script}`], {
      env: { ...process.env, AGENT_FLYWHEEL_HOME: h, ...env },
    }).toString();
  } catch (e) {
    return (e.stdout || "").toString();
  }
}

test("flywheel_load_config: a crafted key cannot execute a command (source-time RCE guard)", () => {
  const home = mkdtempSync(join(tmpdir(), "af-lib-"));
  const sentinel = join(home, "PWNED");
  // Two classic key-injection payloads that a naive eval on the key would run.
  writeFileSync(
    join(home, "config.env"),
    `AGENT_FLYWHEEL_x};touch ${sentinel};#=1\n` +
      `AGENT_FLYWHEEL_y:-$(touch ${sentinel})=1\n`,
  );
  const out = bash('echo "mode=${AGENT_FLYWHEEL_SELF_IMPROVE_MODE:-unset}"', { home });
  assert.equal(existsSync(sentinel), false, "no command executed from config.env keys");
  assert.match(out, /mode=unset/, "malicious keys are not assigned");
});

test("flywheel_load_config: a legitimate key IS applied, and an env var overrides the file", () => {
  const home = mkdtempSync(join(tmpdir(), "af-lib-"));
  writeFileSync(join(home, "config.env"), "AGENT_FLYWHEEL_SELF_IMPROVE_MODE=off\n");
  assert.match(bash('echo "m=$AGENT_FLYWHEEL_SELF_IMPROVE_MODE"', { home }), /m=off/);
  assert.match(
    bash('echo "m=$AGENT_FLYWHEEL_SELF_IMPROVE_MODE"', { home, env: { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "every-session" } }),
    /m=every-session/,
  );
});

test("flywheel_cli_note resolves to this install's bin/agent-flywheel", () => {
  const out = bash("flywheel_cli_note");
  assert.match(out, /agent-flywheel CLI for this install:/);
  assert.match(out, new RegExp(`${REPO_ROOT.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bin/agent-flywheel`));
});

test("flywheel_path_trusted: owner + not group/other-writable passes; a writable file fails", () => {
  const home = mkdtempSync(join(tmpdir(), "af-lib-"));
  const f = join(home, "install.sh");
  writeFileSync(f, "#!/usr/bin/env bash\n");
  chmodSync(f, 0o755);
  assert.match(bash(`flywheel_path_trusted "${f}" && echo TRUSTED || echo NO`, { home }), /TRUSTED/);
  chmodSync(f, 0o757); // other-writable
  assert.match(bash(`flywheel_path_trusted "${f}" && echo TRUSTED || echo NO`, { home }), /NO/);
  chmodSync(f, 0o775); // group-writable
  assert.match(bash(`flywheel_path_trusted "${f}" && echo TRUSTED || echo NO`, { home }), /NO/);
  assert.match(bash(`flywheel_path_trusted "${home}/does-not-exist" && echo TRUSTED || echo NO`, { home }), /NO/);
});

test("flywheel_self_improve_due mode=days fires once then dedups the same day", () => {
  const home = mkdtempSync(join(tmpdir(), "af-lib-"));
  const today = new Date().toLocaleDateString("en-US", { weekday: "short" });
  const env = { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "days", AGENT_FLYWHEEL_SELF_IMPROVE_DAYS: today };
  // First check today: due.
  assert.match(bash('flywheel_self_improve_due session-end && echo DUE || echo NO', { home, env }), /DUE/);
  // Mark ran, then a second check the same day: not due (once-per-day).
  bash("flywheel_mark_self_improve_ran", { home });
  assert.match(bash('flywheel_self_improve_due session-end && echo DUE || echo NO', { home, env }), /NO/);
});
