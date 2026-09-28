import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { claudeArgsForSpec } from "./index.js";
import { claudeSkillsPlugin, claudeSkillsRoot, skillsSetDigest } from "./skills-plugin.js";

let root: string;
let prevConfigDir: string | undefined;

function writeSkill(name: string): string {
  const dir = join(root, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} desc\n---\n`);
  return dir;
}

function spec(
  access: "readonly" | "workspace_write",
  skills: Array<{ name: string; path: string }>,
) {
  return HarnessRunSpec.parse({
    session_id: "sess-skills",
    intent: "explain",
    prompt: "x",
    cwd: root,
    access,
    external_context_policy: "off",
    tool_permission_policy: { web: "off", allow: [], deny: [] },
    skills,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudexor-claude-skills-"));
  prevConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "config");
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = prevConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe("claudeSkillsPlugin", () => {
  it("materializes skills under the Claudexor-owned root, keyed by content", () => {
    const skills = [
      { name: "alpha", path: writeSkill("alpha") },
      { name: "beta", path: writeSkill("beta") },
    ];
    const result = claudeSkillsPlugin(skills);
    expect(result.pluginDir).toBe(join(claudeSkillsRoot(), skillsSetDigest(skills)));
    expect(result.names).toEqual(["alpha", "beta"]);
    expect(existsSync(join(result.pluginDir!, "skills", "beta", "SKILL.md"))).toBe(true);
  });

  it("reuses the same directory for the same skill set (no cross-project race)", () => {
    const skills = [{ name: "alpha", path: writeSkill("alpha") }];
    const first = claudeSkillsPlugin(skills);
    const second = claudeSkillsPlugin([...skills]);
    expect(second.pluginDir).toBe(first.pluginDir);
  });

  it("separates different skill sets into different directories", () => {
    const a = claudeSkillsPlugin([{ name: "alpha", path: writeSkill("alpha") }]);
    const b = claudeSkillsPlugin([{ name: "beta", path: writeSkill("beta") }]);
    expect(a.pluginDir).not.toBe(b.pluginDir);
  });

  it("returns no plugin dir when there are no skills", () => {
    expect(claudeSkillsPlugin([]).pluginDir).toBeNull();
  });
});

describe("claudeArgsForSpec skills wiring", () => {
  it("passes --plugin-dir only when a plugin directory is supplied", () => {
    const runSpec = spec("workspace_write", []);
    const withSkills = claudeArgsForSpec(runSpec, false, false, [], "/owned/skills-plugin");
    expect(withSkills.join(" ")).toContain("--plugin-dir /owned/skills-plugin");
    expect(claudeArgsForSpec(runSpec, false, false, []).join(" ")).not.toContain("--plugin-dir");
  });

  it("keeps readonly lanes' deliberate skills shutdown visible", () => {
    const readonlyArgs = claudeArgsForSpec(spec("readonly", []), false, false, []);
    expect(readonlyArgs).toContain("--disable-slash-commands");
  });

  it("carries the typed skills payload on the spec", () => {
    const parsed = spec("workspace_write", [{ name: "alpha", path: writeSkill("alpha") }]);
    expect(parsed.skills).toEqual([{ name: "alpha", path: join(root, "src", "alpha") }]);
  });

  it("defaults skills to an empty list so unsupported lanes claim nothing", () => {
    expect(
      HarnessRunSpec.parse({ ...spec("workspace_write", []), skills: undefined }).skills,
    ).toEqual([]);
  });
});
