// tests/install-preserves-state.test.mjs
// Regression test for the data-loss class: install.sh syncs the repo INTO
// FLYWHEEL_HOME, the same directory that holds the user's accumulated
// MEMORY.md / GUARDRAILS.md / LEVEL.md / LEARN.log / config.env / cadence
// markers. A naive `rsync --delete` (or the tar-fallback wipe) would delete
// those on every routine re-install because they aren't in the source tree —
// silently destroying the entire point of the loop. sync_repo protects them;
// this pins that they survive a re-sync while managed files still update.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const INSTALL = join(REPO_ROOT, "install.sh");

function install(sandboxHome, flywheelHome, env = {}) {
  // Sandbox HOME so harness wiring (which targets $HOME/.claude, $HOME/.omp)
  // can never touch the real user config; --home isolates the synced tree.
  execFileSync("bash", [INSTALL, "--home", flywheelHome], {
    env: { ...process.env, HOME: sandboxHome, AGENT_FLYWHEEL_HOME: flywheelHome, ...env },
    stdio: "ignore",
  });
}

const STATE = {
  "MEMORY.md": "2026-01-01 a hard-won lesson\n",
  "GUARDRAILS.md": "### G1: never wipe user memory on reinstall\n",
  "LEVEL.md": "2026-01-01  4.5  verified before claiming done\n",
  "LEARN.log": "2026-01-01T00:00:00Z [session-end] wrote G1\n",
  "config.env": "AGENT_FLYWHEEL_SELF_IMPROVE_MODE=off\n",
  ".last-self-improve": "1234567890\n",
};

test("re-running install.sh preserves all user state and still updates managed files", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "af-sandbox-"));
  const home = join(sandbox, ".agent-flywheel");

  install(sandbox, home);
  assert.ok(existsSync(join(home, "core", "prompts", "session-end.txt")), "first install synced managed files");

  // Seed user state as if many sessions had accumulated it.
  for (const [name, body] of Object.entries(STATE)) writeFileSync(join(home, name), body);
  // And a managed file we'll tamper with, to prove re-sync DOES refresh managed files.
  writeFileSync(join(home, "core", "prompts", "session-end.txt"), "TAMPERED\n");

  install(sandbox, home);

  // Every state file survives, byte-for-byte.
  for (const [name, body] of Object.entries(STATE)) {
    assert.equal(readFileSync(join(home, name), "utf8"), body, `${name} must survive re-install`);
  }
  // Managed file is restored from source (not left tampered).
  const managed = readFileSync(join(home, "core", "prompts", "session-end.txt"), "utf8");
  assert.notEqual(managed, "TAMPERED\n", "managed files are re-synced from source");
  assert.match(managed, /reflection pass/i, "managed prompt content is back");
});

test("the tar/find fallback path (no rsync) also preserves user state", () => {
  // The fallback branch does a real `find ... -exec rm -rf` — the more dangerous
  // deletion path. Force it via the AGENT_FLYWHEEL_NO_RSYNC seam so its
  // protect/prune predicate is exercised, not just the rsync --exclude path.
  const sandbox = mkdtempSync(join(tmpdir(), "af-sandbox-"));
  const home = join(sandbox, ".agent-flywheel");
  const noRsync = { AGENT_FLYWHEEL_NO_RSYNC: "1" };

  install(sandbox, home, noRsync);
  assert.ok(existsSync(join(home, "core", "prompts", "session-end.txt")), "fallback install synced managed files");

  for (const [name, body] of Object.entries(STATE)) writeFileSync(join(home, name), body);
  install(sandbox, home, noRsync);

  for (const [name, body] of Object.entries(STATE)) {
    assert.equal(readFileSync(join(home, name), "utf8"), body, `${name} must survive the tar-fallback re-install`);
  }
});

test("first install seeds config.env from config.env.example", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "af-sandbox-"));
  const home = join(sandbox, ".agent-flywheel");
  install(sandbox, home);
  assert.ok(existsSync(join(home, "config.env")), "config.env is seeded on first install (docs promise it exists)");
});
