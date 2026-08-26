// tests/self-improve-cadence.test.mjs
// Verifies the config-driven meta self-improvement cadence gate
// (`agent-flywheel self-improve --gate`), the durable-memory backend report
// (`agent-flywheel memory --status`), and that the ungated meta pass prints its
// prompt. The cadence decision (flywheel_self_improve_due) is the single source
// of "is the meta pass due now" truth shared by the session-end and periodic
// prompts, so its mode/trigger/days/gap logic and env-over-file precedence are
// the contract worth pinning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "bin", "agent-flywheel");

// Runs the CLI with a fresh isolated home + extra env, returning
// {status, stdout, stderr} without throwing on a non-zero exit (the gate uses
// exit 1 to mean "not due", which is a normal, asserted outcome here).
function run(args, { home, env = {} } = {}) {
  const h = home ?? mkdtempSync(join(tmpdir(), "af-si-"));
  try {
    const stdout = execFileSync(CLI, args, {
      env: { ...process.env, AGENT_FLYWHEEL_HOME: h, ...env },
    }).toString();
    return { status: 0, stdout, home: h };
  } catch (e) {
    return { status: e.status ?? 1, stdout: (e.stdout || "").toString(), stderr: (e.stderr || "").toString(), home: h };
  }
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), "af-si-"));
}

test("self-improve --gate: default (mode=gap, no marker) is DUE at session-end (exit 0)", () => {
  const r = run(["self-improve", "--gate", "--trigger", "session-end"], { home: freshHome() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /META self-improvement pass/);
});

test("self-improve --gate: default TRIGGER=session-end means mid-session is NOT due (exit 1)", () => {
  const r = run(["self-improve", "--gate", "--trigger", "mid-session"], { home: freshHome() });
  assert.equal(r.status, 1);
});

test("self-improve --gate: mode=off is never due (exit 1)", () => {
  const r = run(["self-improve", "--gate"], { home: freshHome(), env: { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "off" } });
  assert.equal(r.status, 1);
});

test("self-improve --gate: mode=every-session is always due (exit 0)", () => {
  const r = run(["self-improve", "--gate"], { home: freshHome(), env: { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "every-session" } });
  assert.equal(r.status, 0);
});

test("self-improve --gate: mode=days matches today (exit 0) and misses a bogus day (exit 1)", () => {
  const today = new Date().toLocaleDateString("en-US", { weekday: "short" }); // Mon..Sun
  const hit = run(["self-improve", "--gate"], {
    home: freshHome(),
    env: { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "days", AGENT_FLYWHEEL_SELF_IMPROVE_DAYS: today },
  });
  assert.equal(hit.status, 0);
  const miss = run(["self-improve", "--gate"], {
    home: freshHome(),
    env: { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "days", AGENT_FLYWHEEL_SELF_IMPROVE_DAYS: "Xyz" },
  });
  assert.equal(miss.status, 1);
});

test("self-improve --gate: --mark then re-gate is NOT due within the gap (exit 1)", () => {
  const home = freshHome();
  const first = run(["self-improve", "--gate", "--mark"], { home });
  assert.equal(first.status, 0);
  const second = run(["self-improve", "--gate"], { home }); // default gap=7d, marker just set
  assert.equal(second.status, 1);
});

test("self-improve --gate mode=days: fires once, then dedups the rest of the same day (CLI path)", () => {
  const home = freshHome();
  const today = new Date().toLocaleDateString("en-US", { weekday: "short" });
  const env = { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "days", AGENT_FLYWHEEL_SELF_IMPROVE_DAYS: today };
  assert.equal(run(["self-improve", "--gate", "--mark"], { home, env }).status, 0, "first matching-day gate is due");
  assert.equal(run(["self-improve", "--gate"], { home, env }).status, 1, "second same-day gate dedups");
});

test("config.env drives the gate, and an env var overrides the file", () => {
  const home = freshHome();
  // File says off -> not due.
  writeFileSync(join(home, "config.env"), "AGENT_FLYWHEEL_SELF_IMPROVE_MODE=off\n");
  assert.equal(run(["self-improve", "--gate"], { home }).status, 1);
  // Env var of the same name wins over the file -> due again.
  const overridden = run(["self-improve", "--gate"], { home, env: { AGENT_FLYWHEEL_SELF_IMPROVE_MODE: "every-session" } });
  assert.equal(overridden.status, 0);
});

test("self-improve without --gate always prints the meta prompt with the repo locator", () => {
  const r = run(["self-improve", "--repo", "/tmp/some-checkout"], { home: freshHome() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /META self-improvement pass/);
  assert.match(r.stdout, /The agent-flywheel repo checkout to assess is at: \/tmp\/some-checkout/);
  assert.doesNotMatch(r.stdout, /despite --resume/); // meta pass never resumes a session
});

test("memory --status always reports the flat-file baseline pointing at MEMORY.md", () => {
  const home = freshHome();
  const r = run(["memory", "--status"], { home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /flat-file/);
  assert.match(r.stdout, new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/MEMORY\\.md`));
});
