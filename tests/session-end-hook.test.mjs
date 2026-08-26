// tests/session-end-hook.test.mjs
// Guards on the Claude Code SessionEnd hook. HERMETIC: `claude` is shadowed by a
// stub on PATH so the test can NEVER launch a real `claude -p` reflection (an
// earlier version of this test leaked real background claude processes when a
// guard regressed — never again). The stub records its argv, letting us assert
// BOTH the skip paths (no spawn) and the spawn contract (no --resume, uses
// --no-session-persistence) without any real model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK = join(REPO_ROOT, "adapters", "claude-code", "hooks", "session-end.sh");

// Build an isolated env: a stub-`claude` on PATH that appends its argv to
// $CLAUDE_STUB_LOG, plus a fresh FLYWHEEL_HOME. Returns paths to inspect.
function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), "af-hook-"));
  const binDir = mkdtempSync(join(tmpdir(), "af-bin-"));
  const stubLog = join(home, "claude-stub.log");
  const stub = join(binDir, "claude");
  // Records argv (newline-terminated), exits 0 immediately — no model call.
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${stubLog}"\nexit 0\n`);
  chmodSync(stub, 0o755);
  return { home, stubLog, env: { AGENT_FLYWHEEL_HOME: home, PATH: `${binDir}:${process.env.PATH}` } };
}

function runHook(inputObj, env) {
  execFileSync("bash", [HOOK], { input: JSON.stringify(inputObj), env: { ...process.env, ...env } });
}

function lockCount(home) {
  const dir = join(home, "watchers");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".reflect-lock")).length : 0;
}

// The reflection is spawned detached (`nohup … &`); poll briefly for the stub log.
function waitForStub(stubLog, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(stubLog)) return readFileSync(stubLog, "utf8");
    execFileSync("sleep", ["0.05"]);
  }
  return "";
}

test("SessionEnd skips reason=resume — no lock, no claude spawn", () => {
  const { home, stubLog, env } = makeEnv();
  runHook({ session_id: "abc-123", transcript_path: "/tmp/x.jsonl", reason: "resume" }, env);
  assert.equal(lockCount(home), 0, "no reflect-lock for reason=resume");
  assert.equal(existsSync(stubLog), false, "claude was NOT spawned");
});

test("SessionEnd refuses to run without a transcript path — no claude spawn", () => {
  const { home, stubLog, env } = makeEnv();
  runHook({ session_id: "abc-123", reason: "other" }, env);
  assert.equal(lockCount(home), 0);
  assert.equal(existsSync(stubLog), false, "claude was NOT spawned");
});

test("SessionEnd with a terminal reason + transcript DOES spawn — with --no-session-persistence and NOT --resume", () => {
  const { stubLog, env } = makeEnv();
  runHook({ session_id: "abc-123", transcript_path: "/tmp/x.jsonl", reason: "other" }, env);
  const argv = waitForStub(stubLog);
  assert.match(argv, /--no-session-persistence/, "reflection spawn uses --no-session-persistence");
  assert.doesNotMatch(argv, /--resume/, "reflection spawn must NOT use --resume (fails with 'No conversation found')");
});
