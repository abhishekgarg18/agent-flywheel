// tests/skill-scaffold.test.mjs
// Unit tests for scripts/skill-scaffold.mjs's exported helpers, plus a CLI
// integration test (spawned as a real subprocess) covering the new/list
// exit-code contract `agent-flywheel skill` depends on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillTemplate, parseFrontmatter, scaffoldSkill, listSkills } from "../scripts/skill-scaffold.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "af-skill-scaffold-"));
}

test("skillTemplate: embeds name and description in frontmatter", () => {
  const text = skillTemplate("my-skill", "Use when testing things.");
  assert.match(text, /^---\nname: my-skill\ndescription: Use when testing things\.\n---/);
});

test("parseFrontmatter: extracts name/description from a well-formed SKILL.md", () => {
  const text = skillTemplate("my-skill", "Use when testing things.");
  assert.deepEqual(parseFrontmatter(text), { name: "my-skill", description: "Use when testing things." });
});

test("parseFrontmatter: returns null when there is no frontmatter block", () => {
  assert.equal(parseFrontmatter("# just a heading\nno frontmatter here\n"), null);
});

test("scaffoldSkill: rejects a non-kebab-case name", () => {
  const root = tmpDir();
  assert.throws(() => scaffoldSkill("Not_Kebab", root, "desc"), /kebab-case/);
  rmSync(root, { recursive: true, force: true });
});

test("scaffoldSkill: rejects a missing/blank description", () => {
  const root = tmpDir();
  assert.throws(() => scaffoldSkill("my-skill", root, ""), /description/);
  assert.throws(() => scaffoldSkill("my-skill", root, "   "), /description/);
  rmSync(root, { recursive: true, force: true });
});

test("scaffoldSkill: writes SKILL.md + references/ and refuses to clobber without --force", () => {
  const root = tmpDir();
  const path = scaffoldSkill("my-skill", root, "Use when testing scaffolding.");
  assert.ok(existsSync(path));
  assert.ok(existsSync(join(root, "my-skill", "references")));
  assert.match(readFileSync(path, "utf8"), /name: my-skill/);

  assert.throws(() => scaffoldSkill("my-skill", root, "second description"), /already exists/);

  // force overwrites
  const path2 = scaffoldSkill("my-skill", root, "second description", { force: true });
  assert.match(readFileSync(path2, "utf8"), /description: second description/);
  rmSync(root, { recursive: true, force: true });
});

test("listSkills: returns [] for a root that doesn't exist yet (CHECK-EXISTING: nothing here)", () => {
  assert.deepEqual(listSkills(join(tmpdir(), "af-skill-scaffold-does-not-exist")), []);
});

test("listSkills: lists scaffolded skills sorted by name, tolerating a directory with no SKILL.md", () => {
  const root = tmpDir();
  scaffoldSkill("zeta-skill", root, "Z description");
  scaffoldSkill("alpha-skill", root, "A description");
  // Non-skill directory (e.g. a stray dir) must be skipped, not error.
  mkdtempSync(join(root, "not-a-skill-"));

  const skills = listSkills(root);
  assert.deepEqual(
    skills.map((s) => s.name),
    ["alpha-skill", "zeta-skill"],
  );
  assert.equal(skills[0].description, "A description");
  rmSync(root, { recursive: true, force: true });
});

test("listSkills: falls back to the directory name and a placeholder when frontmatter fields are missing", () => {
  const root = tmpDir();
  scaffoldSkill("has-frontmatter", root, "real description");
  const dir = join(root, "no-frontmatter");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# no frontmatter here\n");

  const skills = listSkills(root);
  const broken = skills.find((s) => s.name === "no-frontmatter");
  assert.ok(broken);
  assert.equal(broken.description, "(no description field)");
  rmSync(root, { recursive: true, force: true });
});


test("CLI: `new` creates a skill and exits 0; re-running without --force exits 1", () => {
  const root = tmpDir();
  const script = new URL("../scripts/skill-scaffold.mjs", import.meta.url).pathname;
  const out = execFileSync("node", [script, "new", "cli-skill", "--root", root, "--description", "Use when testing the CLI."])
    .toString()
    .trim();
  assert.match(out, /^created /);
  assert.ok(existsSync(join(root, "cli-skill", "SKILL.md")));

  assert.throws(() => execFileSync("node", [script, "new", "cli-skill", "--root", root, "--description", "again"], { stdio: "pipe" }), (err) => err.status === 1);
  rmSync(root, { recursive: true, force: true });
});

test("CLI: `new` without --root exits 2 with a usage error", () => {
  const script = new URL("../scripts/skill-scaffold.mjs", import.meta.url).pathname;
  assert.throws(() => execFileSync("node", [script, "new", "x"], { stdio: "pipe" }), (err) => err.status === 2);
});

test("CLI: `list --json` prints a JSON array matching listSkills output", () => {
  const root = tmpDir();
  const script = new URL("../scripts/skill-scaffold.mjs", import.meta.url).pathname;
  scaffoldSkill("json-skill", root, "Use when testing JSON output.");
  const out = execFileSync("node", [script, "list", "--root", root, "--json"]).toString();
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "json-skill");
  rmSync(root, { recursive: true, force: true });
});

test("CLI: `list` on a nonexistent root exits 0 and prints nothing", () => {
  const script = new URL("../scripts/skill-scaffold.mjs", import.meta.url).pathname;
  const out = execFileSync("node", [script, "list", "--root", join(tmpdir(), "af-skill-scaffold-does-not-exist")]).toString();
  assert.equal(out, "");
});
