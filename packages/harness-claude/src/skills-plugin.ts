/**
 * Claude run-time skills delivery.
 *
 * The engine resolves the user's Agent Skills (`spec.skills`) and this module
 * turns them into ONE plugin directory, handed to the child with
 * `--plugin-dir` — Claude Code's documented "load a plugin from a directory"
 * switch. Nothing is written into the vendor config dir, so a run can never
 * collide with, or clobber, skills the user installed there themselves.
 *
 * The directory is keyed by a digest of the RESOLVED skill set, which gives
 * three properties at once: a rerun with the same set reuses the same bytes
 * (idempotent writes), two projects with different skills cannot overwrite each
 * other's plugin while both run (the race a single shared dir would create),
 * and a changed skill set gets a fresh directory instead of a partially
 * rewritten one. Stale directories under the owned root are pruned by age.
 */
import { createHash } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtraSkill } from "@claudexor/schema";
import { claudexorOwnedRoot } from "@claudexor/util";
import { materializeClaudeSkillsPlugin, type DiscoveredSkill } from "@claudexor/core";

/** Owned root for materialized skill plugins (one subdirectory per skill set). */
export function claudeSkillsRoot(): string {
  return join(claudexorOwnedRoot(), "skills-plugins", "claude");
}

/** Stale plugin dirs older than this are pruned on the next materialization. */
const SKILLS_PLUGIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Stable identity of a skill set: name plus source path, order-independent. */
export function skillsSetDigest(skills: readonly ExtraSkill[]): string {
  const canonical = skills
    .map((skill) => `${skill.name}\u0000${skill.path}`)
    .sort()
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function pruneStalePluginDirs(root: string, keep: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== keep)
      .map((entry) => entry.name);
  } catch {
    return;
  }
  const cutoff = Date.now() - SKILLS_PLUGIN_MAX_AGE_MS;
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: a leftover plugin dir is inert */
    }
  }
}

export interface ClaudeSkillsPluginResult {
  /** Directory to pass as `--plugin-dir`, or null when nothing was materialized. */
  pluginDir: string | null;
  /** Skill names actually materialized. */
  names: string[];
  /** Non-fatal materialization problems, surfaced rather than swallowed. */
  problems: string[];
}

/**
 * Materialize `spec.skills` for one attempt. Returns `pluginDir: null` when the
 * list is empty or every skill failed to materialize, so the caller passes no
 * flag instead of pointing Claude at an empty plugin.
 */
export function claudeSkillsPlugin(skills: readonly ExtraSkill[]): ClaudeSkillsPluginResult {
  if (skills.length === 0) return { pluginDir: null, names: [], problems: [] };
  const root = claudeSkillsRoot();
  const digest = skillsSetDigest(skills);
  const discovered: DiscoveredSkill[] = skills.map((skill) => ({
    name: skill.name,
    path: skill.path,
    source: skill.path,
    description: null,
  }));
  const { plugin, problems } = materializeClaudeSkillsPlugin(join(root, digest), discovered);
  pruneStalePluginDirs(root, digest);
  if (!plugin) {
    return {
      pluginDir: null,
      names: [],
      problems: problems.map((problem) => `${problem.name}: ${problem.reason}`),
    };
  }
  return {
    pluginDir: plugin.pluginDir,
    names: plugin.names,
    problems: problems.map((problem) => `${problem.name}: ${problem.reason}`),
  };
}
