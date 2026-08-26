// tests/idle-gap.test.mjs
// Unit tests for scripts/idle-gap.mjs's exported helpers, plus a CLI
// integration test (spawned as a real subprocess) covering the
// check/mark exit-code contract every adapter's periodic watcher depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isIdleLongEnough, gapLongEnough, writeMarker } from "../scripts/idle-gap.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "af-idle-gap-"));
}

test("isIdleLongEnough: false for a missing transcript (nothing to be idle about)", () => {
  assert.equal(isIdleLongEnough("/does/not/exist", 300), false);
});

test("isIdleLongEnough: false when the transcript was touched more recently than idleSeconds", () => {
  const root = tmpDir();
  const file = join(root, "t.jsonl");
  writeFileSync(file, "{}");
  const now = Date.now();
  assert.equal(isIdleLongEnough(file, 300, now), false);
  rmSync(root, { recursive: true, force: true });
});

test("isIdleLongEnough: true once idleSeconds have elapsed since the transcript's mtime", () => {
  const root = tmpDir();
  const file = join(root, "t.jsonl");
  writeFileSync(file, "{}");
  const past = new Date(Date.now() - 400_000);
  utimesSync(file, past, past);
  assert.equal(isIdleLongEnough(file, 300, Date.now()), true);
  rmSync(root, { recursive: true, force: true });
});

test("gapLongEnough: true when no marker file exists yet (never ran)", () => {
  const root = tmpDir();
  assert.equal(gapLongEnough(join(root, "missing-marker"), 7200), true);
  rmSync(root, { recursive: true, force: true });
});

test("gapLongEnough: false immediately after writeMarker; true once minGapSeconds has passed", () => {
  const root = tmpDir();
  const marker = join(root, ".last-periodic-reflection");
  const now = Date.now();
  writeMarker(marker, now);
  assert.equal(gapLongEnough(marker, 7200, now + 1000), false);
  assert.equal(gapLongEnough(marker, 7200, now + 7_201_000), true);
  rmSync(root, { recursive: true, force: true });
});

test("gapLongEnough: tolerates a corrupt/non-numeric marker file as if it never ran", () => {
  const root = tmpDir();
  const marker = join(root, ".last-periodic-reflection");
  writeFileSync(marker, "not-a-number");
  assert.equal(gapLongEnough(marker, 7200), true);
  rmSync(root, { recursive: true, force: true });
});

test("CLI: `check` exits 0 (\"fire\") only when both idle and gap conditions hold", () => {
  const root = tmpDir();
  const script = new URL("../scripts/idle-gap.mjs", import.meta.url).pathname;
  const transcript = join(root, "t.jsonl");
  const marker = join(root, "marker");
  writeFileSync(transcript, "{}");
  const past = new Date(Date.now() - 400_000);
  utimesSync(transcript, past, past);

  // Idle long enough, no marker yet -> fire.
  const out1 = execFileSync("node", [script, "check", "--transcript", transcript, "--marker", marker, "--idle-seconds", "300", "--min-gap-seconds", "7200"]).toString().trim();
  assert.equal(out1, "fire");

  // Mark, then immediately re-check -> skip (gap not satisfied).
  execFileSync("node", [script, "mark", "--marker", marker]);
  assert.throws(() => execFileSync("node", [script, "check", "--transcript", transcript, "--marker", marker, "--idle-seconds", "300", "--min-gap-seconds", "7200"], { stdio: "pipe" }));

  rmSync(root, { recursive: true, force: true });
});

test("CLI: `check` without --transcript exits 2 with a usage error", () => {
  const script = new URL("../scripts/idle-gap.mjs", import.meta.url).pathname;
  assert.throws(() => execFileSync("node", [script, "check"], { stdio: "pipe" }), (err) => err.status === 2);
});
