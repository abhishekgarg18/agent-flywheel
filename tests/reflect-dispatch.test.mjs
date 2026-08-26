// tests/reflect-dispatch.test.mjs
// Verifies `agent-flywheel reflect --harness <name> --session <path> --print`
// emits a shell-safe, exactly-round-trippable resume command for each
// supported harness — the contract spawn_harness_resume() shares between
// --print and the real detached-spawn path in bin/agent-flywheel. Rather
// than pattern-match bash's `printf %q` quoting scheme, each printed line is
// executed with the target harness binary shadowed by a bash function that
// dumps its exact argv — proving round-trip fidelity (including the
// multi-line prompt text) regardless of which quoting bash chose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "bin", "agent-flywheel");
const SESSION_PATH = "/tmp/agent-flywheel-test-session.jsonl";

// harness param (as accepted by --harness) -> the binary name the printed
// command invokes, and the argv shape (in terms of which slot holds the
// prompt vs. the session path) that spawn_harness_resume's case branch for
// that harness emits.
const HARNESSES = {
  omp: { bin: "omp", argvOf: (prompt, session) => ["-p", prompt, "--resume", session] },
  "claude-code": { bin: "claude", argvOf: (prompt, session) => ["-p", prompt, "--resume", session] },
  codex: { bin: "codex", argvOf: (prompt, session) => ["exec", "resume", session, prompt] },
  copilot: { bin: "copilot", argvOf: (prompt, session) => ["--resume", session, "-p", prompt] },
};

function printReflect(harness, home) {
  return execFileSync(CLI, ["reflect", "--harness", harness, "--session", SESSION_PATH, "--print"], {
    env: { ...process.env, AGENT_FLYWHEEL_HOME: home },
  }).toString();
}

// Runs the printed command line with `binName` shadowed by a bash function
// that records its argv, then returns that argv split on a sentinel byte
// (\x1e, never legitimately present in prompt text) instead of newlines —
// the prompt itself contains newlines, so joining on \x1e keeps each
// captured argument intact for a lossless comparison.
function capturedArgv(printedLine, binName, workDir) {
  const script = `
set -euo pipefail
${binName}() {
  local out="" a
  for a in "$@"; do
    out+="\${a}"$'\\x1e'
  done
  printf '%s' "$out"
}
${printedLine}
`;
  const scriptFile = join(workDir, `${binName}.sh`);
  writeFileSync(scriptFile, script);
  const out = execFileSync("bash", [scriptFile]).toString();
  // Drop the trailing sentinel from the final joined argument.
  return out.slice(0, -1).split("\x1e");
}

for (const [harness, { bin, argvOf }] of Object.entries(HARNESSES)) {
  test(`reflect --print --harness ${harness}: prints a round-trippable ${bin} resume command`, () => {
    const home = mkdtempSync(join(tmpdir(), "af-reflect-home-"));
    const work = mkdtempSync(join(tmpdir(), "af-reflect-work-"));
    try {
      const printed = printReflect(harness, home);
      assert.match(printed, new RegExp(`^${bin} `));

      const argv = capturedArgv(printed, bin, work);
      const expectedPrompt = execFileSync(CLI, ["prompt", "session-end", "--session", SESSION_PATH], {
        env: { ...process.env, AGENT_FLYWHEEL_HOME: home },
      })
        .toString()
        // `$(...)` command substitution inside spawn_harness_resume strips
        // the trailing newline(s) before embedding the prompt; match that.
        .replace(/\n+$/, "");
      assert.deepEqual(argv, argvOf(expectedPrompt, SESSION_PATH));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
}

test("reflect: an unsupported --harness value fails with exit 2 (unchanged since --print is print-only)", () => {
  assert.throws(
    () => execFileSync(CLI, ["reflect", "--harness", "nonexistent-tool", "--session", SESSION_PATH, "--print"], { stdio: "pipe" }),
    (err) => err.status === 2,
  );
});

test("reflect: with no --session, prints the inline prompt instead of dispatching to any harness", () => {
  const out = execFileSync(CLI, ["reflect", "--trigger", "session-end"]).toString();
  const expected = execFileSync(CLI, ["prompt", "session-end"]).toString();
  assert.equal(out, expected);
  assert.doesNotMatch(out, /^(omp|claude|codex|copilot) /);
});
