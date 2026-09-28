import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, materializeClaudeSkillsPlugin } from "./skills.js";

let root: string;

function writeSkill(dir: string, name: string, description = "d", extra = ""): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n${extra}`,
  );
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudexor-skills-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  it("finds one skill per child directory holding SKILL.md", () => {
    const source = join(root, "global");
    writeSkill(join(source, "alpha"), "alpha", "first");
    writeSkill(join(source, "beta"), "beta", "second");
    // A directory without SKILL.md is not a skill.
    mkdirSync(join(source, "not-a-skill"), { recursive: true });

    const { skills, problems } = discoverSkills([source]);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(skills[0]?.description).toBe("first");
    expect(problems).toEqual([]);
  });

  it("treats a source directory that IS a skill as one skill", () => {
    const skill = writeSkill(join(root, "solo"), "solo");
    const { skills } = discoverSkills([skill]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toBe(skill);
  });

  it("lets a later source override an earlier one and records the override", () => {
    const global = writeSkill(join(root, "global", "dup"), "dup", "from global");
    const project = writeSkill(join(root, "project", "dup"), "dup", "from project");

    const { skills, problems } = discoverSkills([join(root, "global"), join(root, "project")]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toBe(project);
    expect(skills[0]?.description).toBe("from project");
    expect(problems[0]?.reason).toContain("overrides");
    expect(global).not.toBe(project);
  });

  it("skips names that cannot be a vendor skill id and reports why", () => {
    const source = join(root, "global");
    writeSkill(join(source, "BadName"), "Bad Name");
    writeSkill(join(source, "good"), "good");

    const { skills, problems } = discoverSkills([source]);
    expect(skills.map((s) => s.name)).toEqual(["good"]);
    expect(problems[0]?.reason).toContain("lowercase alphanumeric/hyphen");
  });

  it("ignores missing sources and returns empty discovery", () => {
    const { skills, problems } = discoverSkills([join(root, "nope")]);
    expect(skills).toEqual([]);
    expect(problems).toEqual([]);
  });
});

describe("materializeClaudeSkillsPlugin", () => {
  const discovered = (names: string[]) =>
    names.map((name) => ({
      name,
      path: writeSkill(join(root, "src", name), name),
      source: join(root, "src"),
      description: null,
    }));

  it("writes a managed plugin bundle with per-skill SKILL.md", () => {
    const pluginDir = join(root, "plugin");
    const { plugin, problems } = materializeClaudeSkillsPlugin(pluginDir, discovered(["alpha"]));

    expect(problems).toEqual([]);
    expect(plugin?.pluginDir).toBe(pluginDir);
    expect(plugin?.names).toEqual(["alpha"]);
    expect(existsSync(join(pluginDir, ".claudexor-managed"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")).name,
    ).toBe("claudexor-user-skills");
    // The skill is exposed by link (or copy) and readable either way.
    const skillMd = join(pluginDir, "skills", "alpha", "SKILL.md");
    expect(readFileSync(skillMd, "utf8")).toContain("Body for alpha");
  });

  it("is idempotent and prunes skill entries it previously created", () => {
    const pluginDir = join(root, "plugin");
    materializeClaudeSkillsPlugin(pluginDir, discovered(["alpha", "beta"]));
    expect(existsSync(join(pluginDir, "skills", "beta", "SKILL.md"))).toBe(true);

    const { plugin } = materializeClaudeSkillsPlugin(pluginDir, discovered(["alpha"]));
    expect(plugin?.names).toEqual(["alpha"]);
    expect(existsSync(join(pluginDir, "skills", "beta"))).toBe(false);
  });

  it("never prunes an entry it does not own", () => {
    const pluginDir = join(root, "plugin");
    materializeClaudeSkillsPlugin(pluginDir, discovered(["alpha"]));
    // A user's own skill inside the plugin dir (no marker content, no link).
    const foreign = join(pluginDir, "skills", "mine");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "# hand-written by the user\n");

    materializeClaudeSkillsPlugin(pluginDir, discovered(["beta"]));
    expect(existsSync(join(foreign, "SKILL.md"))).toBe(true);
  });

  it("refuses an existing directory it does not own", () => {
    const pluginDir = join(root, "occupied");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "keep.txt"), "user data\n");

    const { plugin, problems } = materializeClaudeSkillsPlugin(pluginDir, discovered(["alpha"]));
    expect(plugin).toBeNull();
    expect(problems[0]?.reason).toContain("unmanaged directory");
    expect(readFileSync(join(pluginDir, "keep.txt"), "utf8")).toBe("user data\n");
  });

  it("returns null with no skills to write", () => {
    expect(materializeClaudeSkillsPlugin(join(root, "p"), []).plugin).toBeNull();
  });

  it("links the source so a later edit to the skill is picked up", () => {
    const [alpha] = discovered(["alpha"]);
    const pluginDir = join(root, "plugin");
    materializeClaudeSkillsPlugin(pluginDir, [alpha!]);
    const skillMd = join(pluginDir, "skills", "alpha", "SKILL.md");
    let linked = true;
    try {
      readlinkSync(skillMd);
    } catch {
      linked = false;
    }
    if (linked) {
      writeFileSync(join(alpha!.path, "SKILL.md"), "---\nname: alpha\ndescription: d\n---\nLIVE\n");
      expect(readFileSync(skillMd, "utf8")).toContain("LIVE");
    }
  });
});
