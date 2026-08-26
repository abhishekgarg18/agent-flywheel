// tests/advisor-autotune.test.mjs
// Unit tests for scripts/advisor-autotune.mjs's pure/testable exports, plus
// an end-to-end run() test against real temp files (no mocking fs — this
// script's whole job is filesystem I/O, so faking it would test nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseArgs,
  findAdvisorTranscripts,
  scanAdvisorFile,
  computeStats,
  disableAdvisorInConfig,
  run,
} from "../scripts/advisor-autotune.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "af-autotune-"));
}

test("parseArgs: defaults", () => {
  const args = parseArgs([]);
  assert.equal(args.minSample, 8);
  assert.equal(args.lookback, 15);
  assert.equal(args.report, false);
});

test("parseArgs: overrides and both --report/--dry-run aliases", () => {
  assert.deepEqual(parseArgs(["--config", "c.yml", "--sessions-dir", "d", "--min-sample", "3", "--lookback", "5", "--report"]), {
    minSample: 3,
    lookback: 5,
    report: true,
    config: "c.yml",
    sessionsDir: "d",
  });
  assert.equal(parseArgs(["--dry-run"]).report, true);
});

test("findAdvisorTranscripts: recurses, matches __advisor*.jsonl only, tolerates missing root", () => {
  const root = tmpDir();
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "__advisor.a1.jsonl"), "{}\n");
  writeFileSync(join(root, "nested", "__advisor.b2.jsonl"), "{}\n");
  writeFileSync(join(root, "not-advisor.jsonl"), "{}\n");
  writeFileSync(join(root, "__advisor.txt"), "not jsonl\n");

  const found = findAdvisorTranscripts(root).map((f) => f.path).sort();
  assert.deepEqual(found, [join(root, "__advisor.a1.jsonl"), join(root, "nested", "__advisor.b2.jsonl")].sort());

  assert.deepEqual(findAdvisorTranscripts(join(root, "does-not-exist")), []);
  rmSync(root, { recursive: true, force: true });
});

test("scanAdvisorFile: collects nested severity fields, skips malformed lines, tolerates missing file", () => {
  const root = tmpDir();
  const file = join(root, "__advisor.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ result: { severity: "nit" } }),
      "not json at all",
      JSON.stringify({ items: [{ severity: "CONCERN" }, { nested: { severity: "blocker" } }] }),
      "",
    ].join("\n"),
  );
  assert.deepEqual(scanAdvisorFile(file), ["nit", "concern", "blocker"]);
  assert.deepEqual(scanAdvisorFile(join(root, "missing.jsonl")), []);
  rmSync(root, { recursive: true, force: true });
});

test("computeStats: insufficient sample never recommends disable regardless of severities", () => {
  const root = tmpDir();
  writeFileSync(join(root, "__advisor.1.jsonl"), JSON.stringify({ severity: "nit" }) + "\n");
  const stats = computeStats(root, { minSample: 8, lookback: 15 });
  assert.equal(stats.reviewed, 1);
  assert.equal(stats.sufficientSample, false);
  assert.equal(stats.recommendDisable, false);
  rmSync(root, { recursive: true, force: true });
});

test("computeStats: sufficient sample + zero concerns/blockers recommends disable", () => {
  const root = tmpDir();
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(root, `__advisor.${i}.jsonl`), JSON.stringify({ severity: "nit" }) + "\n");
  }
  const stats = computeStats(root, { minSample: 8, lookback: 15 });
  assert.equal(stats.reviewed, 8);
  assert.equal(stats.sufficientSample, true);
  assert.equal(stats.recommendDisable, true);
  assert.equal(stats.counts.nit, 8);
  rmSync(root, { recursive: true, force: true });
});

test("computeStats: a single blocker in a sufficient sample blocks the disable recommendation", () => {
  const root = tmpDir();
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(root, `__advisor.${i}.jsonl`), JSON.stringify({ severity: "nit" }) + "\n");
  }
  writeFileSync(join(root, "__advisor.7.jsonl"), JSON.stringify({ severity: "blocker" }) + "\n");
  const stats = computeStats(root, { minSample: 8, lookback: 15 });
  assert.equal(stats.sufficientSample, true);
  assert.equal(stats.recommendDisable, false);
  assert.equal(stats.counts.blocker, 1);
  rmSync(root, { recursive: true, force: true });
});

test("computeStats: lookback caps how many (most-recent) transcripts are scanned", () => {
  const root = tmpDir();
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(root, `__advisor.${i}.jsonl`), JSON.stringify({ severity: "nit" }) + "\n");
  }
  const stats = computeStats(root, { minSample: 8, lookback: 5 });
  assert.equal(stats.reviewed, 5);
  rmSync(root, { recursive: true, force: true });
});

test("disableAdvisorInConfig: flips enabled: true only inside the advisor: block", () => {
  const text = ["modelRoles:", "  default: x", "", "advisor:", "  enabled: true", "  immuneTurns: 3", "", "other: y"].join("\n");
  const { changed, text: out } = disableAdvisorInConfig(text);
  assert.equal(changed, true);
  assert.match(out, /advisor:\n {2}enabled: false\n {2}immuneTurns: 3/);
  assert.match(out, /^modelRoles:\n {2}default: x/);
  assert.match(out, /other: y$/);
});

test("disableAdvisorInConfig: leaves an enabled: true that belongs to a different top-level block untouched", () => {
  const text = ["other:", "  enabled: true", "", "advisor:", "  immuneTurns: 3"].join("\n");
  const { changed, text: out } = disableAdvisorInConfig(text);
  assert.equal(changed, false);
  assert.equal(out, text);
});

test("disableAdvisorInConfig: no advisor: block at all is a no-op, not an error", () => {
  const text = "modelRoles:\n  default: x\n";
  const { changed, text: out } = disableAdvisorInConfig(text);
  assert.equal(changed, false);
  assert.equal(out, text);
});

test("disableAdvisorInConfig: already-disabled advisor block is a no-op", () => {
  const text = "advisor:\n  enabled: false\n";
  const { changed } = disableAdvisorInConfig(text);
  assert.equal(changed, false);
});

test("run(): insufficient sample never touches config.yml", () => {
  const root = tmpDir();
  const configPath = join(root, "config.yml");
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(configPath, "advisor:\n  enabled: true\n");

  const code = run(["--config", configPath, "--sessions-dir", sessionsDir], { flywheelHome: root });
  assert.equal(code, 0);
  assert.equal(readFileSync(configPath, "utf8"), "advisor:\n  enabled: true\n");
  rmSync(root, { recursive: true, force: true });
});

test("run(): --report never mutates config.yml even when disable is recommended", () => {
  const root = tmpDir();
  const configPath = join(root, "config.yml");
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(sessionsDir, `__advisor.${i}.jsonl`), JSON.stringify({ severity: "nit" }) + "\n");
  }
  writeFileSync(configPath, "advisor:\n  enabled: true\n");

  const code = run(["--config", configPath, "--sessions-dir", sessionsDir, "--min-sample", "8", "--report"], { flywheelHome: root });
  assert.equal(code, 0);
  assert.equal(readFileSync(configPath, "utf8"), "advisor:\n  enabled: true\n");
  rmSync(root, { recursive: true, force: true });
});

test("run(): sufficient sample + zero concerns/blockers disables advisor.enabled and logs the decision", () => {
  const root = tmpDir();
  const configPath = join(root, "config.yml");
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(sessionsDir, `__advisor.${i}.jsonl`), JSON.stringify({ severity: "nit" }) + "\n");
  }
  writeFileSync(configPath, "advisor:\n  enabled: true\n  immuneTurns: 3\n");

  const code = run(["--config", configPath, "--sessions-dir", sessionsDir, "--min-sample", "8"], { flywheelHome: root });
  assert.equal(code, 0);
  assert.equal(readFileSync(configPath, "utf8"), "advisor:\n  enabled: false\n  immuneTurns: 3\n");

  const log = readFileSync(join(root, "advisor-autotune-decisions.log"), "utf8").trim();
  const entry = JSON.parse(log.split("\n").pop());
  assert.equal(entry.action, "disabled");
  rmSync(root, { recursive: true, force: true });
});

test("run(): sufficient sample with a real concern/blocker leaves config.yml untouched", () => {
  const root = tmpDir();
  const configPath = join(root, "config.yml");
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(sessionsDir, `__advisor.${i}.jsonl`), JSON.stringify({ severity: "nit" }) + "\n");
  }
  writeFileSync(join(sessionsDir, "__advisor.7.jsonl"), JSON.stringify({ severity: "concern" }) + "\n");
  writeFileSync(configPath, "advisor:\n  enabled: true\n");

  const code = run(["--config", configPath, "--sessions-dir", sessionsDir, "--min-sample", "8"], { flywheelHome: root });
  assert.equal(code, 0);
  assert.equal(readFileSync(configPath, "utf8"), "advisor:\n  enabled: true\n");
  rmSync(root, { recursive: true, force: true });
});

test("run(): missing --config/--sessions-dir returns exit code 2", () => {
  assert.equal(run([]), 2);
});
