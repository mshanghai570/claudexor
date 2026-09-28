/**
 * Agent Skills (the `SKILL.md` convention): discovery from user-configured
 * directories, and materialization into the native shape one harness can load.
 *
 * Discovery is deliberately dumb and filesystem-only: a source directory holds
 * one skill per DIRECT child directory containing a `SKILL.md`, and a source
 * directory that itself contains `SKILL.md` is a single skill. Sources are
 * ordered weakest-first, so a later source (the project) overrides an earlier
 * one (the user's global root) by name.
 *
 * Materialization never invents a vendor layout it cannot prove: the Claude
 * plugin bundle written here is the exact skills-directory plugin shape
 * `claudexor plugin install claude` already ships and tests, and every file it
 * creates carries the managed marker so a stale entry can be pruned without
 * ever touching a file the user (or a host) owns.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { copyFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The marker every generated skill artifact carries. */
export const SKILLS_MANAGED_MARKER = "claudexor:managed";

/** A skill name must be usable verbatim as a vendor skill id and a path segment. */
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface DiscoveredSkill {
  name: string;
  /** Absolute path of the skill's own directory (the one holding SKILL.md). */
  path: string;
  /** The source directory this skill came from (later sources win). */
  source: string;
  /** The SKILL.md `description` field when it parses, else null. */
  description: string | null;
}

export interface SkillDiscoveryProblem {
  source: string;
  name: string;
  reason: string;
}

export interface SkillDiscovery {
  skills: DiscoveredSkill[];
  /** Skipped entries, each with the reason — reported, never silently dropped. */
  problems: SkillDiscoveryProblem[];
}

/**
 * Minimal, dependency-free reader for a SKILL.md frontmatter block. Only the
 * two fields the index needs are read; a body or malformed block yields nulls
 * rather than an error, because a skill with a bad header is still a skill.
 */
function readSkillHeader(skillMd: string): { name: string | null; description: string | null } {
  let text: string;
  try {
    text = readFileSync(skillMd, "utf8");
  } catch {
    return { name: null, description: null };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { name: null, description: null };
  let name: string | null = null;
  let description: string | null = null;
  for (const rawLine of (match[1] ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = (field[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (field[1] === "name") name = value;
    else description = value;
  }
  return { name, description };
}

/** True when `dir` is a skill directory (holds SKILL.md as a regular file). */
function isSkillDir(dir: string): boolean {
  try {
    return lstatSync(join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

/**
 * Discover the skills reachable from `sourceDirs`, weakest source first. A
 * later source overrides an earlier one by SKILL name (so a project skill wins
 * over the user's global skill of the same name), and the override is recorded
 * in `problems` as an informational note instead of vanishing.
 */
export function discoverSkills(sourceDirs: readonly string[]): SkillDiscovery {
  const byName = new Map<string, DiscoveredSkill>();
  const problems: SkillDiscoveryProblem[] = [];
  for (const rawSource of sourceDirs) {
    const source = rawSource;
    if (!source || !existsSync(source)) continue;
    // A source that IS a skill: `--skills-dir /path/to/my-skill`.
    if (isSkillDir(source)) {
      const header = readSkillHeader(join(source, "SKILL.md"));
      const name = header.name ?? basename(source);
      if (!SAFE_SKILL_NAME.test(name)) {
        problems.push({
          source,
          name,
          reason: "skill name must be lowercase alphanumeric/hyphen",
        });
        continue;
      }
      byName.set(name, {
        name,
        path: source,
        source,
        description: header.description,
      });
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch (err) {
      problems.push({
        source,
        name: "-",
        reason: `cannot read skills directory: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const entry of entries) {
      const dir = join(source, entry);
      if (!isSkillDir(dir)) continue;
      const header = readSkillHeader(join(dir, "SKILL.md"));
      const name = header.name ?? entry;
      if (!SAFE_SKILL_NAME.test(name)) {
        problems.push({
          source,
          name,
          reason: `skill name must be lowercase alphanumeric/hyphen (directory ${entry})`,
        });
        continue;
      }
      const previous = byName.get(name);
      if (previous && previous.source !== source) {
        problems.push({
          source,
          name,
          reason: `overrides the skill from ${previous.source}`,
        });
      }
      byName.set(name, { name, path: dir, source, description: header.description });
    }
  }
  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  };
}

export interface MaterializedSkillPlugin {
  /** Absolute plugin directory to hand the harness (claude: `--plugin-dir`). */
  pluginDir: string;
  /** Skill names actually materialized, sorted. */
  names: string[];
}

function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    /* absent or unreadable: write it */
  }
  writeFileSync(path, content);
}

/**
 * Materialize `skills` as a Claude Code skills-directory plugin under
 * `pluginDir`, returning null when there is nothing to write.
 *
 * Layout (the exact shape the managed `claudexor` plugin install already
 * produces, so it is the one the product can claim):
 *
 *   <pluginDir>/.claude-plugin/plugin.json    (managed marker)
 *   <pluginDir>/skills/<name>/SKILL.md        (symlink to the source, else copy)
 *
 * Idempotent: a rerun rewrites only what changed and PRUNES skill entries this
 * function previously created but that are no longer in `skills` — by their
 * marker, never by directory sweep. A `pluginDir` that exists without the
 * marker is left completely alone (the user may own it), and the caller is told
 * via `refused`.
 */
export function materializeClaudeSkillsPlugin(
  pluginDir: string,
  skills: readonly DiscoveredSkill[],
): { plugin: MaterializedSkillPlugin | null; problems: SkillDiscoveryProblem[] } {
  const problems: SkillDiscoveryProblem[] = [];
  if (skills.length === 0) return { plugin: null, problems };
  const markerPath = join(pluginDir, ".claudexor-managed");
  const owns = existsSync(markerPath);
  if (!owns && existsSync(pluginDir)) {
    problems.push({
      source: pluginDir,
      name: "-",
      reason: "refusing to write skills into an existing unmanaged directory",
    });
    return { plugin: null, problems };
  }
  try {
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginDir, "skills"), { recursive: true });
    writeIfChanged(markerPath, `${SKILLS_MANAGED_MARKER}\n`);
    writeIfChanged(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: "claudexor-user-skills",
          version: "1.0.0",
          description: `User skills materialized by Claudexor (${SKILLS_MANAGED_MARKER})`,
        },
        null,
        2,
      )}\n`,
    );
    const wanted = new Set(skills.map((skill) => skill.name));
    const skillsRoot = join(pluginDir, "skills");
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || wanted.has(entry.name)) continue;
      // Prune ONLY entries this function owns: each is `<skills>/<name>/SKILL.md`
      // and is a symlink or the copied managed file.
      const skillDir = join(skillsRoot, entry.name);
      const skillMd = join(skillDir, "SKILL.md");
      try {
        const link = lstatSync(skillMd).isSymbolicLink();
        const managed = link || readFileSync(skillMd, "utf8").includes(SKILLS_MANAGED_MARKER);
        if (managed) rmSync(skillDir, { recursive: true, force: true });
      } catch {
        /* unreadable: leave it alone */
      }
    }
    const names: string[] = [];
    for (const skill of skills) {
      const target = join(skillsRoot, skill.name);
      const skillMd = join(target, "SKILL.md");
      mkdirSync(target, { recursive: true });
      const source = join(skill.path, "SKILL.md");
      let linked = false;
      try {
        const stat = lstatSync(skillMd);
        linked = stat.isSymbolicLink();
      } catch {
        /* absent */
      }
      if (!linked) {
        try {
          rmSync(skillMd, { force: true });
          symlinkSync(source, skillMd);
          linked = true;
        } catch {
          /* symlinks unavailable (or the target is owned): fall through to a copy */
        }
      }
      if (!linked) {
        try {
          copyFileSync(source, skillMd);
          writeFileSync(
            skillMd,
            `${readFileSync(skillMd, "utf8")}`.trimEnd() + `\n<!-- ${SKILLS_MANAGED_MARKER} -->\n`,
          );
        } catch (err) {
          problems.push({
            source: skill.path,
            name: skill.name,
            reason: `could not materialize: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
      }
      names.push(skill.name);
    }
    if (names.length === 0) return { plugin: null, problems };
    return { plugin: { pluginDir, names: names.sort() }, problems };
  } catch (err) {
    problems.push({
      source: pluginDir,
      name: "-",
      reason: `could not prepare skills plugin: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { plugin: null, problems };
  }
}
