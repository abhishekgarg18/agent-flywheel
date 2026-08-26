#!/usr/bin/env node
// scripts/idle-gap.mjs
//
// Shared idle/rate-limit check for the periodic (mid-session) reflection
// checkpoint on harnesses that don't have a native background-timer
// primitive exposed to hook scripts (Claude Code, Codex CLI, GitHub Copilot
// CLI — omp's extension does this in-process instead, see
// adapters/omp/extensions/self-improvement-loop.ts). Implemented in Node
// rather than bash because file-mtime comparisons need `stat`, and BSD
// `stat` (macOS) and GNU `stat` (Linux) take different flags — Node's
// `fs.statSync` sidesteps that portability trap entirely.
//
// Usage:
//   node idle-gap.mjs check --transcript <path> --idle-seconds 300 --min-gap-seconds 7200 [--marker <path>]
//     Exit 0 ("fire") if the transcript has been idle >= idle-seconds AND
//     the shared marker file says at least min-gap-seconds have passed
//     since the last periodic reflection across ANY harness on this
//     machine. Exit 1 ("skip") otherwise. Never throws: a missing
//     transcript or marker is treated as "not enough information, skip".
//   node idle-gap.mjs mark [--marker <path>]
//     Records "now" in the marker file. Call this only after successfully
//     spawning a reflection pass, not before.

import { statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function defaultMarker() {
  return join(process.env.AGENT_FLYWHEEL_HOME || join(homedir(), ".agent-flywheel"), ".last-periodic-reflection");
}

export function isIdleLongEnough(transcriptPath, idleSeconds, nowMs = Date.now()) {
  let mtimeMs;
  try {
    mtimeMs = statSync(transcriptPath).mtimeMs;
  } catch {
    return false; // no transcript yet: nothing to be idle about
  }
  return (nowMs - mtimeMs) / 1000 >= idleSeconds;
}

export function gapLongEnough(markerPath, minGapSeconds, nowMs = Date.now()) {
  let last = 0;
  try {
    last = Number(readFileSync(markerPath, "utf8").trim()) || 0;
  } catch {
    return true; // no marker yet: never ran, so the gap is trivially satisfied
  }
  return (nowMs - last) / 1000 >= minGapSeconds;
}

export function writeMarker(markerPath, nowMs = Date.now()) {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, String(nowMs));
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const marker = args.marker || defaultMarker();

  if (cmd === "mark") {
    writeMarker(marker);
    return 0;
  }

  if (cmd === "check") {
    if (!args.transcript) {
      console.error("idle-gap.mjs check requires --transcript <path>");
      return 2;
    }
    const idleSeconds = Number(args["idle-seconds"] || 300);
    const minGapSeconds = Number(args["min-gap-seconds"] || 7200);
    const idle = isIdleLongEnough(args.transcript, idleSeconds);
    const gapOk = gapLongEnough(marker, minGapSeconds);
    if (idle && gapOk) {
      console.log("fire");
      return 0;
    }
    console.log("skip");
    return 1;
  }

  console.error("usage: idle-gap.mjs <check|mark> [options]");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
