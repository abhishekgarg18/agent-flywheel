import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

  function spawnReflection(
    sessionFile: string,
    trigger: string,
    opts?: { promptFile?: string; framing?: string },
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
        `pre-loaded from that file despite --resume.`;
    } catch {
      return; // shared prompt file missing (not installed yet): nothing safe to run
    }

    try {
      const fd = openLogFd(REFLECTION_LOG);
      const child = spawn("omp", ["-p", prompt, "--resume", sessionFile], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, AGENT_FLYWHEEL_PASS: "1" },
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
  pi.on("session_start", async (_event, ctx) => {
    if (isReflectionPass || periodicTimerArmed) return;
    periodicTimerArmed = true;

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
      });
    }, PERIODIC_CHECK_MS);
  });

  // Fires on /new (and /fork, /resume) within the same still-running process.
  pi.on("session_switch", (event, _ctx) => {
    if (isReflectionPass) return;
    if (event?.reason !== "new") return; // skip fork/resume: nothing "ended"
    const previous = event?.previousSessionFile;
    if (!previous) return;
    spawnReflection(previous, "/new");
  });

  // Fires on real process exit (Ctrl+D, closing the terminal, /exit) — the
  // only path where the process itself is torn down rather than switched.
  pi.on("session_shutdown", (_event, ctx) => {
    if (isReflectionPass) return;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile) return;
    spawnReflection(sessionFile, "process exit");
  });
}
