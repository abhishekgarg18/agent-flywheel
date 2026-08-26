import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// agent-flywheel — omp adapter.
//
// Makes the reflect -> write -> proceduralize loop automatic at session
// boundaries AND periodically mid-session, instead of relying on a human
// (or the agent itself) to remember to trigger it. The prompt text lives at
// ~/.agent-flywheel/core/prompts/*.txt — the SAME files read by the Claude
// Code / Codex / Copilot adapters, so the chain stays byte-identical across
// every harness instead of drifting copies. See README.md for the full
// architecture and the Reflexion/CoALA framing this is built on.
//
// CLOSING PATHS (verified against omp's session-operations and extension
// docs, not assumed):
//   /new    -> emits `session_switch` (reason "new", carries
//              `previousSessionFile`); the process itself stays alive.
//   /clear  -> emits no session lifecycle hook at all (an in-place marker
//              only) — nothing to hook here, by design of the event model.
//   exit    -> real process teardown emits `session_shutdown`.
//
// Neither event can force one more turn in the process that is
// switching/closing, so both handlers spawn a detached headless `omp -p`
// subprocess against the session file that just ended, guarded by
// AGENT_FLYWHEEL_PASS so that subprocess's own shutdown does not spawn
// another one recursively.
//
// PERIODIC MID-SESSION CHECKPOINT: the two triggers above only fire at
// session boundaries — a session left open and idle for hours never gets a
// reflection pass until it finally closes. `ctx.setInterval` is the
// documented, contained primitive for extension background work (throws
// are caught, auto-cleared on `session_shutdown`, unref'd so it never keeps
// the process alive on its own). Every PERIODIC_CHECK_MS, while idle, this
// fires a lightweight idle-checkpoint pass — a different, "still running"
// prompt, never the close-out prompt, which would falsely tell the
// reflection pass the session had ended. A marker file shared with every
// other installed harness bounds this to at most one real pass per
// MIN_PERIODIC_GAP_MS across the whole machine, so leaving many terminals
// open doesn't multiply cost.
//
// ADVISOR AUTO-TUNE: before spawning any reflection pass, best-effort runs
// scripts/advisor-autotune.mjs, which deterministically disables omp's
// native `advisor` subsystem in config.yml if it has reviewed a real sample
// of sessions and never once raised anything above a "nit" — i.e. it isn't
// earning its cost. This is intentionally code, not an LLM instruction: a
// mechanical boolean flip should never depend on a model "remembering" to
// check it.
const FLYWHEEL_HOME = join(homedir(), ".agent-flywheel");
const PROMPT_FILE = join(FLYWHEEL_HOME, "core", "prompts", "session-end.txt");
const PERIODIC_PROMPT_FILE = join(FLYWHEEL_HOME, "core", "prompts", "periodic.txt");
const NUDGE_FILE = join(FLYWHEEL_HOME, "core", "prompts", "maturity-nudge.txt");
const PERIODIC_MARKER_FILE = join(FLYWHEEL_HOME, ".last-periodic-reflection");
const ADVISOR_AUTOTUNE_SCRIPT = join(FLYWHEEL_HOME, "scripts", "advisor-autotune.mjs");
const ADVISOR_AUTOTUNE_LOG = join(FLYWHEEL_HOME, "advisor-autotune.log");
const REFLECTION_LOG = join(FLYWHEEL_HOME, "reflection.log");
const GUARDRAILS_FILE = join(FLYWHEEL_HOME, "GUARDRAILS.md");
const LEVEL_FILE = join(FLYWHEEL_HOME, "LEVEL.md");
const OMP_CONFIG_FILE = join(homedir(), ".omp", "agent", "config.yml");
const OMP_SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");
// Cadence knobs. Defaults match the bash side (core/lib.sh / periodic-watcher);
// both harnesses read the SAME ~/.agent-flywheel/config.env so a user tuning the
// cadence once applies it everywhere, instead of omp drifting from Claude Code.
const DEFAULT_PERIODIC_CHECK_MS = 15 * 60 * 1000; // how often the idle check runs
const DEFAULT_MIN_PERIODIC_GAP_MS = 2 * 60 * 60 * 1000; // floor between actual passes
const CONFIG_FILE = join(FLYWHEEL_HOME, "config.env");

// Minimal KEY=VALUE reader for the same config.env the bash side sources — no
// YAML/dotenv dep, only AGENT_FLYWHEEL_* keys, env var wins over file (parity
// with flywheel_load_config's precedence). Best-effort: a missing/garbled file
// just yields the defaults.
function readConfigSeconds(key: string, fallbackMs: number): number {
  const envVal = process.env[key];
  const fromEnv = envVal !== undefined ? Number(envVal) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv * 1000;
  try {
    for (const line of readFileSync(CONFIG_FILE, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.startsWith(key + "=")) continue;
      const v = Number(t.slice(key.length + 1).trim());
      if (Number.isFinite(v) && v > 0) return v * 1000;
    }
  } catch {
    // no config file / unreadable: fall through to the default
  }
  return fallbackMs;
}

const PERIODIC_CHECK_MS = readConfigSeconds("AGENT_FLYWHEEL_PERIODIC_CHECK_SECONDS", DEFAULT_PERIODIC_CHECK_MS);
const MIN_PERIODIC_GAP_MS = readConfigSeconds("AGENT_FLYWHEEL_MIN_PERIODIC_GAP_SECONDS", DEFAULT_MIN_PERIODIC_GAP_MS);

// String config reader (env var wins over config.env, same precedence as the
// bash side) for the session-start primer flags.
function readConfigStr(key: string, fallback: string): string {
  const envVal = process.env[key];
  if (envVal !== undefined && envVal !== "") return envVal;
  try {
    for (const line of readFileSync(CONFIG_FILE, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.startsWith(key + "=")) continue;
      const v = t.slice(key.length + 1).trim();
      if (v) return v;
    }
  } catch {
    // no config file: use fallback
  }
  return fallback;
}

export default function selfImprovementLoop(pi: ExtensionAPI): void {
  let firstTurnSeen = false;
  let periodicTimerArmed = false;
  const isReflectionPass = process.env.AGENT_FLYWHEEL_PASS === "1";

  function openLogFd(path: string): number | "ignore" {
    try {
      return openSync(path, "a");
    } catch {
      return "ignore";
    }
  }

  function runAdvisorAutotune() {
    const fd = openLogFd(ADVISOR_AUTOTUNE_LOG);
    try {
      spawnSync("node", [ADVISOR_AUTOTUNE_SCRIPT, "--config", OMP_CONFIG_FILE, "--sessions-dir", OMP_SESSIONS_DIR], {
        stdio: ["ignore", fd, fd],
        timeout: 5000,
      });
    } catch {
      // Best-effort: a missing node/script must never block reflection.
    }
  }

  // Delta framing (parity with bash flywheel_delta_note): a periodic checkpoint
  // re-reads a still-open session each time it fires; the marker lets the next
  // pass scope itself to only what's new since the last one instead of re-scanning
  // and re-storing early material. Keyed by session-file basename, kept under the
  // protected watchers/ dir. Best-effort throughout.
  function reflectedMarker(sessionFile: string): string {
    return join(FLYWHEEL_HOME, "watchers", basename(sessionFile) + ".reflected-at");
  }
  function readReflectedAt(sessionFile: string): number {
    try {
      return Number(readFileSync(reflectedMarker(sessionFile), "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  }
  function markReflected(sessionFile: string) {
    try {
      mkdirSync(join(FLYWHEEL_HOME, "watchers"), { recursive: true });
      writeFileSync(reflectedMarker(sessionFile), String(Math.floor(Date.now() / 1000)));
    } catch {
      // best-effort marker
    }
  }
  function deltaNote(sessionFile: string): string {
    const last = readReflectedAt(sessionFile);
    if (!last) return "";
    return (
      `\n\nDELTA FRAME: a prior checkpoint this session already reflected on ` +
      `everything up to ${new Date(last * 1000).toISOString()}. Only capture ` +
      `what is NEW since then — do not re-scan or re-store earlier material; ` +
      `dedupe against MEMORY.md.`
    );
  }

  // Machine-wide reflection rate limit (parity with bash flywheel_reflect_gap_ok):
  // rapid /new + exit cycling would otherwise each spawn a reflection, and every
  // pass writes memory — which bursts the memory backend (and, with memorix
  // maintenance running through a local model, storms the CPU). Bound
  // session-boundary reflections to once per gap across the machine.
  const REFLECT_MARKER = join(FLYWHEEL_HOME, ".last-reflection");
  const MIN_REFLECT_GAP_MS =
    (Number(readConfigStr("AGENT_FLYWHEEL_MIN_REFLECT_GAP_SECONDS", "120")) || 120) * 1000;
  function reflectGapOk(): boolean {
    if (MIN_REFLECT_GAP_MS <= 0) return true;
    try {
      const last = (Number(readFileSync(REFLECT_MARKER, "utf8").trim()) || 0) * 1000;
      if (Date.now() - last < MIN_REFLECT_GAP_MS) return false;
    } catch {
      // no marker yet: allowed
    }
    return true;
  }
  function markReflected() {
    try {
      writeFileSync(REFLECT_MARKER, String(Math.floor(Date.now() / 1000)));
    } catch {
      // best-effort
    }
  }

  function spawnReflection(
    sessionFile: string,
    trigger: string,
    opts?: { promptFile?: string; framing?: string; extra?: string },
  ) {
    runAdvisorAutotune();

    const promptFile = opts?.promptFile ?? PROMPT_FILE;
    const framing = opts?.framing ?? "The session that just ended";
    let prompt: string;
    try {
      prompt =
        `(${trigger}) ${readFileSync(promptFile, "utf8").trim()}\n\n` +
        `${framing} is recorded at: ${sessionFile} — read it directly (the ` +
        `read tool, JSON Lines) for full grounding before acting; this ` +
        `reflection pass's own conversation history starts blank, it is NOT ` +
        `pre-loaded from that file despite --resume.` +
        (opts?.extra ?? "") +
        `\n\nagent-flywheel CLI for this install: ${join(FLYWHEEL_HOME, "bin", "agent-flywheel")} ` +
        `— use this exact path for any \`agent-flywheel ...\` command referenced ` +
        `above; it is NOT assumed to be on PATH in this reflection subprocess.`;
    } catch {
      return; // shared prompt file missing (not installed yet): nothing safe to run
    }

    try {
      const fd = openLogFd(REFLECTION_LOG);
      // Ensure reflection subprocess has project context for memorix hook delivery.
      // The subprocess inherits process.env but may need explicit working directory
      // and HOME for memorix to properly bind project and deliver hooks.
      const child = spawn("omp", ["-p", prompt, "--resume", sessionFile], {
        detached: true,
        stdio: ["ignore", fd, fd],
        cwd: process.cwd(), // Explicit working directory for memorix project binding
        env: {
          ...process.env,
          AGENT_FLYWHEEL_PASS: "1",
          // Ensure memorix finds its stores and config even in subprocess context
          MEMORIX_HOME: process.env.MEMORIX_HOME || join(homedir(), ".memorix"),
        },
      });
      child.unref();
    } catch {
      // Best-effort: closing/exiting must never fail because reflection
      // couldn't spawn.
    }
  }

  // Once per process, on the very first turn, inject the harness-agnostic
  // maturity nudge (core/prompts/maturity-nudge.txt — same file every other
  // adapter reads), PLUS (when present) a scannable index of GUARDRAILS.md
  // titles and the last LEVEL.md trend line — mirrors bash's
  // flywheel_render_nudge so a binding correction from a past session
  // reaches the next session's first turn instead of sitting unread in a
  // file nobody re-opens. Best-effort: a missing nudge file (not installed
  // yet) must never block the turn.
  pi.on("before_agent_start", async () => {
    if (firstTurnSeen || isReflectionPass) return;
    firstTurnSeen = true;

    let nudgeText: string;
    try {
      nudgeText = readFileSync(NUDGE_FILE, "utf8").trim();
    } catch {
      return;
    }

    if (existsSync(GUARDRAILS_FILE)) {
      const titles = readFileSync(GUARDRAILS_FILE, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("### G"))
        .slice(-10);
      if (titles.length > 0) {
        nudgeText += `\n\nActive guardrails from past sessions (binding — read ${GUARDRAILS_FILE} for full detail before acting on any that seem relevant):\n${titles.join("\n")}`;
      }
    }

    if (existsSync(LEVEL_FILE)) {
      const lines = readFileSync(LEVEL_FILE, "utf8").trim().split("\n");
      const last = lines[lines.length - 1];
      if (last) {
        nudgeText += `\n\nLast self-scored level: ${last} (see ${LEVEL_FILE} for trend)`;
      }
    }

    // Session-start primers (parity with bash flywheel_render_session_primers):
    // latest handoff + memorix Workset, config-gated, best-effort.
    if (readConfigStr("AGENT_FLYWHEEL_NUDGE_HANDOFF", "1") !== "0") {
      let hd = readConfigStr("AGENT_FLYWHEEL_HANDOFFS_DIR", join(homedir(), ".claude", "handoffs"));
      if (hd === "~") hd = homedir();
      else if (hd.startsWith("~/")) hd = join(homedir(), hd.slice(2));
      try {
        const latest = readdirSync(hd)
          .filter((f) => f.endsWith(".md"))
          .map((f) => ({ f, m: statSync(join(hd, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0];
        if (latest) nudgeText += `\n\nLatest handoff: ${join(hd, latest.f)} — read it to resume prior work before starting this session.`;
      } catch {
        // no handoffs dir: skip
      }
    }
    if (readConfigStr("AGENT_FLYWHEEL_NUDGE_MEMORIX", "1") !== "0") {
      try {
        const r = spawnSync("memorix", ["context", `resume work in ${basename(process.cwd())}`, "--fallback", "--brief-json"], {
          encoding: "utf8",
          timeout: 5000,
        });
        const brief = (r.stdout || "").trim();
        if (r.status === 0 && brief && brief !== "null") {
          nudgeText += `\n\n[memory] memorix Workset for this project:\n${brief}`;
        }
      } catch {
        // memorix not present / errored: skip
      }
    }

    return {
      message: {
        customType: "agent-flywheel-nudge",
        content: [{ type: "text", text: nudgeText }],
        display: true,
        details: {},
        attribution: "system",
      },
    };
  });

  // Periodic idle checkpoint. Armed once per process; a reflection-pass
  // subprocess never arms its own timer.
  // Bounded reaper (parity with bash flywheel_reap_watchers): reflected-at
  // markers under watchers/ are keyed by session and never removed, and
  // watchers/ is excluded from install's re-sync cleanup — so prune stale ones
  // (>1 day) at session start rather than leak one per session forever.
  function reapWatchers(olderThanMs = 24 * 60 * 60 * 1000) {
    const dir = join(FLYWHEEL_HOME, "watchers");
    try {
      const now = Date.now();
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".reflected-at") && !name.endsWith(".reflect-lock")) continue;
        const p = join(dir, name);
        try {
          if (now - statSync(p).mtimeMs > olderThanMs) rmSync(p, { recursive: true, force: true });
        } catch {
          // ignore a single unremovable entry
        }
      }
    } catch {
      // no watchers/ dir yet, or unreadable: nothing to reap
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (isReflectionPass || periodicTimerArmed) return;
    periodicTimerArmed = true;
    reapWatchers();

    ctx.setInterval(() => {
      if (!ctx.isIdle()) return;
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      if (!sessionFile) return;

      let last = 0;
      try {
        last = Number(readFileSync(PERIODIC_MARKER_FILE, "utf8").trim()) || 0;
      } catch {
        last = 0;
      }
      const now = Date.now();
      if (now - last < MIN_PERIODIC_GAP_MS) return;

      try {
        writeFileSync(PERIODIC_MARKER_FILE, String(now));
      } catch {
        // best-effort marker; a failed write just risks one extra pass
      }

      spawnReflection(sessionFile, "periodic idle checkpoint", {
        promptFile: PERIODIC_PROMPT_FILE,
        framing: "This still-running, idle session, so far,",
        extra: deltaNote(sessionFile),
      });
      // Scope the next checkpoint to only newer activity.
      markReflected(sessionFile);
    }, PERIODIC_CHECK_MS);
  });

  // Fires on /new (and /fork, /resume) within the same still-running process.
  pi.on("session_switch", (event, _ctx) => {
    if (isReflectionPass) return;
    if (event?.reason !== "new") return; // skip fork/resume: nothing "ended"
    const previous = event?.previousSessionFile;
    if (!previous) return;
    if (!reflectGapOk()) return; // machine-wide rate limit (burst -> one)
    spawnReflection(previous, "/new");
    markReflected();
  });

  // Fires on real process exit (Ctrl+D, closing the terminal, /exit) — the
  // only path where the process itself is torn down rather than switched.
  pi.on("session_shutdown", (_event, ctx) => {
    if (isReflectionPass) return;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile) return;
    if (!reflectGapOk()) return; // machine-wide rate limit (burst -> one)
    spawnReflection(sessionFile, "process exit");
    markReflected();
  });
}
