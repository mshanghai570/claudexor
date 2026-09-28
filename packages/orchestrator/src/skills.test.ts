import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GlobalConfig } from "@claudexor/schema";
import { resolveRunSkills, skillSourceDirs } from "./skills.js";

let root: string;

function writeSkill(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} desc\n---\n`);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudexor-orch-skills-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const configWith = (dirs: string[]): GlobalConfig =>
  ({ skills: { directories: dirs } }) as unknown as GlobalConfig;

describe("skillSourceDirs", () => {
  it("orders the managed root first, the project second, and configured dirs last", () => {
    const dirs = skillSourceDirs(configWith([join(root, "extra")]), "/repo", "/cfg");
    expect(dirs).toEqual([
      join("/cfg", "skills"),
      join("/repo", ".claudexor", "skills"),
      join(root, "extra"),
    ]);
  });

  it("expands a leading ~ and drops relative entries", () => {
    const dirs = skillSourceDirs(configWith(["~/team-skills", "relative/path"]), "/repo", "/cfg");
    expect(dirs.at(-1)).toMatch(/team-skills$/);
    expect(dirs).toHaveLength(3);
  });
});

describe("resolveRunSkills", () => {
  it("returns nothing for a harness that cannot load skills", () => {
    const resolved = resolveRunSkills({
      config: configWith([join(root, "extra")]),
      projectRoot: "/repo",
      supportsSkillInjection: false,
    });
    expect(resolved.skills).toEqual([]);
  });

  it("resolves managed, project, and configured skills for a capable harness", () => {
    const cfg = join(root, "cfg");
    writeSkill(join(cfg, "skills", "managed"), "managed");
    const projectRoot = join(root, "repo");
    writeSkill(join(projectRoot, ".claudexor", "skills", "proj"), "proj");
    const extra = join(root, "extra");
    writeSkill(join(extra, "shared"), "shared");

    const resolved = resolveRunSkills({
      config: configWith([extra]),
      projectRoot,
      supportsSkillInjection: true,
      globalDir: cfg,
    });
    expect(resolved.skills.map((s) => s.name)).toEqual(["managed", "proj", "shared"]);
    for (const skill of resolved.skills) expect(skill.path).not.toMatch(/SKILL\.md$/);
  });

  it("emits absolute skill DIRECTORY paths, not the SKILL.md file", () => {
    const cfg = join(root, "cfg");
    writeSkill(join(cfg, "skills", "managed"), "managed");
    const resolved = resolveRunSkills({
      config: undefined,
      projectRoot: join(root, "repo"),
      supportsSkillInjection: true,
      globalDir: cfg,
    });
    expect(resolved.skills[0]?.path).toBe(join(cfg, "skills", "managed"));
  });
});
