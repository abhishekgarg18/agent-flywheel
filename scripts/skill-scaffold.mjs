#!/usr/bin/env node
// scripts/skill-scaffold.mjs
//
// Generic skill scaffolder + lister, used by `agent-flywheel skill new|list`.
// This is the fallback for CREATE/CHECK-EXISTING (core/prompts/reference/
// skill-roots.txt + skill-authoring.txt) when the user's own `skill-creator`
// skill isn't installed — same frontmatter contract either way, so a skill
// scaffolded here is indistinguishable from one skill-creator would produce.
//
// Usage:
//   node skill-scaffold.mjs new <name> --root <dir> --description "<text>" [--force]
//     Writes <dir>/<name>/SKILL.md (frontmatter + template body) and
//     <dir>/<name>/references/ (empty, for progressive disclosure). Refuses
//     to overwrite an existing SKILL.md unless --force.
//   node skill-scaffold.mjs list --root <dir> [--json]
//     Scans <dir>/*/SKILL.md, prints "<name>: <description>" per skill
//     (one line each) or a JSON array with --json. A missing root is not an
//     error — prints nothing and exits 0, since "nothing here yet" is a
//     valid CHECK-EXISTING outcome.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

export function skillTemplate(name, description) {
  return `---
name: ${name}
description: ${description}
---

# ${name}

<!-- What it does, in one sentence. -->

## When to use

<!-- 4-6 concrete trigger phrases/situations — this is what the description
     line above should already summarize; expand here if useful. -->

## Procedure

<!-- The exact steps. Keep this file short (progressive disclosure): move
     long examples, edge-case tables, or per-case detail into references/
     and point at them by name instead of inlining everything here. -->

1.
`;
}

// Extracts { name, description } from a SKILL.md's YAML-ish frontmatter
// without a YAML dependency — the contract is always exactly two scalar
// fields, so a line-based parse is sufficient and dependency-free.
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

export function scaffoldSkill(name, root, description, { force = false } = {}) {
  if (!KEBAB_RE.test(name)) {
    throw new Error(`name must be kebab-case (lowercase, digits, hyphens): "${name}"`);
  }
  if (!description || !description.trim()) {
    throw new Error("a one-sentence --description with concrete trigger phrases is required");
  }
  const dir = join(root, name);
  const skillFile = join(dir, "SKILL.md");
  if (existsSync(skillFile) && !force) {
    throw new Error(`${skillFile} already exists — pass --force to overwrite, or use UPDATE instead of CREATE`);
  }
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(skillFile, skillTemplate(name, description.trim()));
  return skillFile;
}

export function listSkills(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(root, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const fields = parseFrontmatter(readFileSync(skillFile, "utf8"));
    out.push({
      name: fields?.name || entry.name,
      description: fields?.description || "(no description field)",
      path: skillFile,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function main(argv) {
  const args = parseArgs(argv);
  const sub = args._[0];

  if (sub === "new") {
    const name = args._[1];
    if (!name || !args.root) {
      console.error("usage: skill-scaffold.mjs new <name> --root <dir> --description \"<text>\" [--force]");
      return 2;
    }
    try {
      const path = scaffoldSkill(name, args.root, args.description, { force: Boolean(args.force) });
      console.log(`created ${path}`);
      return 0;
    } catch (err) {
      console.error(String(err.message || err));
      return 1;
    }
  }

  if (sub === "list") {
    if (!args.root) {
      console.error("usage: skill-scaffold.mjs list --root <dir> [--json]");
      return 2;
    }
    const skills = listSkills(args.root);
    if (args.json) {
      console.log(JSON.stringify(skills, null, 2));
    } else {
      for (const s of skills) console.log(`${s.name}: ${s.description}`);
    }
    return 0;
  }

  console.error("usage: skill-scaffold.mjs <new|list> ...");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
