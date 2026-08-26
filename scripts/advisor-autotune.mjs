#!/usr/bin/env node
// scripts/advisor-autotune.mjs
//
// Deterministic auto-tune for omp's native `advisor` subsystem (a second,
// continuously-running model reviewing the primary agent's work). If the
// advisor has reviewed a real sample of sessions and never once raised
// anything above a "nit" — it isn't earning the extra API cost — this
// script disables it automatically, in-place, in config.yml. It is
// intentionally NOT an LLM decision: flipping a boolean config value based
// on a mechanical count is exactly the kind of thing that should be code,
// not a "please remember to check this" instruction living in a prompt.
//
// Zero npm dependencies on purpose: this runs from a hook on every session
// end, on every machine that installs agent-flywheel, so it must not carry
// a supply-chain surface beyond Node's stdlib.
//
// Usage:
//   node advisor-autotune.mjs --config <path/to/config.yml> --sessions-dir <path> [options]
//
// Options:
//   --min-sample <n>   Minimum number of reviewed sessions before deciding (default 8)
//   --lookback <n>     Max number of most-recent advisor transcripts to inspect (default 15)
//   --report           Compute and print stats only; never mutate config.yml
//   --dry-run          Same as --report (alias)
//
// Exit code is always 0 (best-effort, non-fatal) unless invoked with bad args.

import { readFileSync, writeFileSync, statSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export function parseArgs(argv) {
  const args = { minSample: 8, lookback: 15, report: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") args.config = argv[++i];
    else if (a === "--sessions-dir") args.sessionsDir = argv[++i];
    else if (a === "--min-sample") args.minSample = Number(argv[++i]);
    else if (a === "--lookback") args.lookback = Number(argv[++i]);
    else if (a === "--report" || a === "--dry-run") args.report = true;
  }
  return args;
}

// Recursively find files matching /__advisor.*\.jsonl$/ under `root`,
// tolerating a missing or unreadable root (best-effort).
export function findAdvisorTranscripts(root) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...findAdvisorTranscripts(full));
    } else if (entry.isFile() && /__advisor.*\.jsonl$/.test(entry.name)) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      out.push({ path: full, mtimeMs });
    }
  }
  return out;
}

// Bounded-depth recursive scan of a parsed JSON value for any `severity`
// field, tolerating whatever shape the advisor tool call/result actually
// takes rather than assuming one exact schema path.
function collectSeverities(value, depth, acc) {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (typeof value.severity === "string") acc.push(value.severity.toLowerCase());
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    collectSeverities(v, depth + 1, acc);
  }
}

export function scanAdvisorFile(path) {
  const severities = [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return severities;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    collectSeverities(obj, 0, severities);
  }
  return severities;
}

export function computeStats(sessionsDir, { minSample, lookback }) {
  const files = findAdvisorTranscripts(sessionsDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, lookback);

  const counts = { nit: 0, concern: 0, blocker: 0, other: 0 };
  for (const f of files) {
    for (const sev of scanAdvisorFile(f.path)) {
      if (sev in counts) counts[sev]++;
      else counts.other++;
    }
  }
  const reviewed = files.length;
  const substantive = counts.concern + counts.blocker;
  const sufficientSample = reviewed >= minSample;
  const recommendDisable = sufficientSample && substantive === 0;
  return { reviewed, counts, sufficientSample, recommendDisable };
}

// Minimal, purpose-built YAML patcher: flips `enabled: true` to
// `enabled: false` ONLY inside the top-level `advisor:` block, preserving
// every other byte of the file. Not a general YAML writer — deliberately
// narrow so its behavior is easy to verify and reason about.
export function disableAdvisorInConfig(text) {
  const lines = text.split("\n");
  let inBlock = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock) {
      if (/^advisor:\s*(#.*)?$/.test(line)) inBlock = true;
      continue;
    }
    // Blank lines and comments don't end the block; a new top-level
    // (unindented, non-blank, non-comment) key does.
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      inBlock = false;
      i--; // re-evaluate this line as a potential new top-level key
      continue;
    }
    const m = line.match(/^(\s+)enabled:\s*true\b(.*)$/);
    if (m) {
      lines[i] = `${m[1]}enabled: false${m[2]}`;
      changed = true;
      break; // one `advisor.enabled` key is all we look for
    }
  }
  return { changed, text: lines.join("\n") };
}

function log(homeDir, entry) {
  const dir = homeDir;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "advisor-autotune-decisions.log"), JSON.stringify(entry) + "\n");
  } catch {
    // best-effort audit trail; never fatal
  }
}

export function run(argv, { flywheelHome = join(homedir(), ".agent-flywheel") } = {}) {
  const args = parseArgs(argv);
  if (!args.config || !args.sessionsDir) {
    console.error("usage: advisor-autotune.mjs --config <config.yml> --sessions-dir <dir> [--min-sample N] [--lookback N] [--report]");
    return 2;
  }

  const stats = computeStats(args.sessionsDir, args);
  const timestamp = new Date().toISOString();

  if (!stats.sufficientSample) {
    console.log(`[advisor-autotune] ${stats.reviewed}/${args.minSample} advisor-reviewed sessions so far — insufficient sample, no decision.`);
    return 0;
  }

  if (!stats.recommendDisable) {
    console.log(`[advisor-autotune] advisor raised ${stats.counts.concern} concern(s) and ${stats.counts.blocker} blocker(s) across ${stats.reviewed} sessions — earning its keep, leaving enabled.`);
    return 0;
  }

  console.log(`[advisor-autotune] advisor raised zero concerns/blockers across the last ${stats.reviewed} reviewed sessions (>= ${args.minSample} sample floor) — recommending disable.`);

  if (args.report) {
    console.log("[advisor-autotune] --report/--dry-run: not mutating config.yml.");
    return 0;
  }

  let configText;
  try {
    configText = readFileSync(args.config, "utf8");
  } catch (err) {
    console.error(`[advisor-autotune] could not read ${args.config}: ${err.message}`);
    return 0;
  }

  const { changed, text } = disableAdvisorInConfig(configText);
  if (!changed) {
    console.log("[advisor-autotune] advisor.enabled: true not found in the expected shape — leaving config.yml untouched; disable it manually if you agree.");
    log(flywheelHome, { timestamp, action: "skip-unexpected-shape", stats });
    return 0;
  }

  writeFileSync(args.config, text);
  console.log(`[advisor-autotune] disabled advisor.enabled in ${args.config}. Re-enable any time by setting it back to true — this only runs the autotune again after another full sample window.`);
  log(flywheelHome, { timestamp, action: "disabled", stats });
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
