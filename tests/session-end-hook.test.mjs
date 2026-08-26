// tests/session-end-hook.test.mjs
// Guards on the Claude Code SessionEnd hook that must hold BEFORE it spawns a
// reflection pass: it must skip reason=resume (not a real end) and refuse to run
// without a transcript path (the pass reads the transcript file directly, so no
// path = a blind pass). Both are early-exit paths, so this test never reaches
// the `claude -p` spawn. Regression guard for the live bug where reflection
// fired on resume/no-transcript and failed with "No conversation found".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK = join(REPO_ROOT, "adapters", "claude-code", "hooks", "session-end.sh");

function runHook(inputObj, home) {
  const res = execFileSync("bash", [HOOK], {
    input: JSON.stringify(inputObj),
    env: { ...process.env, AGENT_FLYWHEEL_HOME: home },
  });
  return res.toString();
}

function lockCount(home) {
  const dir = join(home, "watchers");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => n.endsWith(".reflect-lock")).length;
}

test("SessionEnd skips reason=resume without acquiring a lock or spawning", () => {
  const home = mkdtempSync(join(tmpdir(), "af-hook-"));
  runHook({ session_id: "abc-123", transcript_path: "/tmp/x.jsonl", reason: "resume" }, home);
  assert.equal(lockCount(home), 0, "no reflect-lock created for reason=resume");
});

test("SessionEnd refuses to run without a transcript path", () => {
  const home = mkdtempSync(join(tmpdir(), "af-hook-"));
  runHook({ session_id: "abc-123", reason: "other" }, home); // no transcript_path
  assert.equal(lockCount(home), 0, "no reflect-lock created when transcript is absent");
});

test("SessionEnd exits cleanly (no session_id -> no-op)", () => {
  const home = mkdtempSync(join(tmpdir(), "af-hook-"));
  runHook({ reason: "other" }, home);
  assert.equal(lockCount(home), 0);
});
