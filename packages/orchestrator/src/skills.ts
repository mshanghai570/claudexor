/**
 * Agent Skills resolution (engine side): turn the user's configured skill
 * sources into the typed `HarnessRunSpec.skills` payload for harnesses that
 * declare `capability_profile.skill_injection`.
 *
 * Sources, weakest first so a project overrides the user's global skill of the
 * same name:
 *   1. `<global config dir>/skills`      — Claudexor-managed user skills
 *   2. `<project root>/.claudexor/skills` — versioned project skills
 *   3. `skills.directories` from global config, in order (an explicit path may
 *      start with `~/`)
 *
 * Discovery never throws: an unreadable or malformed source is reported as a
 * problem and the remaining skills still reach the run.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { globalConfigDir } from "@claudexor/config";
import type { ExtraSkill, GlobalConfig } from "@claudexor/schema";
import { discoverSkills, type DiscoveredSkill, type SkillDiscoveryProblem } from "@claudexor/core";

export interface ResolvedSkills {
  skills: ExtraSkill[];
  discovered: DiscoveredSkill[];
  problems: SkillDiscoveryProblem[];
}

/** Expand a leading `~` (the only home reference config accepts, never `$VAR`). */
function expandHome(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return dir;
}

/** The ordered source directories for a project. */
export function skillSourceDirs(
  config: GlobalConfig | undefined,
  projectRoot: string,
  globalDir: string = globalConfigDir(),
): string[] {
  const configured = (config?.skills?.directories ?? [])
    .map((dir) => expandHome(dir.trim()))
    .filter((dir) => dir.length > 0 && isAbsolute(dir));
  return [join(globalDir, "skills"), join(projectRoot, ".claudexor", "skills"), ...configured];
}

/** Resolve the run's skills payload; empty for a harness that cannot load them. */
export function resolveRunSkills(input: {
  config: GlobalConfig | undefined;
  projectRoot: string;
  supportsSkillInjection: boolean;
  globalDir?: string;
}): ResolvedSkills {
  if (!input.supportsSkillInjection) return { skills: [], discovered: [], problems: [] };
  const dirs = skillSourceDirs(input.config, input.projectRoot, input.globalDir);
  const discovery = discoverSkills(dirs);
  return {
    skills: discovery.skills.map((skill) => ({ name: skill.name, path: skill.path })),
    discovered: discovery.skills,
    problems: discovery.problems,
  };
}

/**
 * The `HarnessRunSpec.skills` field for one attempt, as a single expression.
 * A thin wrapper so the orchestrator's spec construction stays a field list
 * instead of growing an inline object literal per feature.
 */
export function specSkills(input: {
  config: GlobalConfig | undefined;
  projectRoot: string;
  supportsSkillInjection: boolean;
  globalDir?: string;
}): ExtraSkill[] {
  return resolveRunSkills(input).skills;
}
