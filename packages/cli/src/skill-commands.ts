/**
 * `claudexor skills` — show the Agent Skills the engine will hand to runs.
 *
 * Read-only and honest: it reports the SAME discovery the run path performs
 * (`resolveRunSkills` over `<config>/skills`, `<project>/.claudexor/skills`, and
 * the configured `skills.directories`), plus which harnesses accept injected
 * skills. It never prints skill bodies.
 */
import { loadConfig } from "@claudexor/config";
import { resolveRunSkills } from "@claudexor/orchestrator";
import { buildRegistry } from "./registry.js";
import type { ParsedArgs } from "./args.js";
import { printJson } from "./cli-io.js";

const USAGE = "usage: claudexor skills [list] [--all]";

export async function skillsCommand(args: ParsedArgs, json: boolean): Promise<{ status: number }> {
  const sub = args._[1];
  if (sub !== undefined && sub !== "list") {
    if (json) printJson({ ok: false, error: USAGE });
    else console.error(USAGE);
    return { status: 2 };
  }
  const includeFakes = args.flags["all"] === true;
  const repoRoot = process.cwd();
  let config;
  try {
    config = loadConfig(repoRoot).global;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) printJson({ ok: false, error: message });
    else console.error(message);
    return { status: 2 };
  }

  // Which harnesses would actually receive skills: the adapters that declare
  // skill_injection, read from their manifests (the same truth the router uses).
  const registry = buildRegistry({ includeFakes });
  const accepting: string[] = [];
  for (const [id, adapter] of registry) {
    try {
      const manifest = await adapter.discover();
      if (manifest.capability_profile.skill_injection) accepting.push(id);
    } catch {
      /* an unavailable adapter simply cannot accept skills right now */
    }
  }

  const resolved = resolveRunSkills({
    config,
    projectRoot: repoRoot,
    supportsSkillInjection: true,
  });

  if (json) {
    printJson({
      ok: true,
      skills: resolved.discovered.map((skill) => ({
        name: skill.name,
        path: skill.path,
        source: skill.source,
        description: skill.description,
      })),
      problems: resolved.problems,
      harnesses: accepting.sort(),
    });
  } else {
    if (resolved.discovered.length === 0) {
      console.log("no skills found");
      console.log(
        "add one at <config>/skills/<name>/SKILL.md, .claudexor/skills/<name>/SKILL.md, or a skills.directories entry",
      );
    } else {
      for (const skill of resolved.discovered) {
        console.log(`${skill.name}  ${skill.description ?? "(no description)"}`);
        console.log(`        ${skill.path}`);
      }
    }
    for (const problem of resolved.problems) {
      console.log(`note: ${problem.name} (${problem.source}): ${problem.reason}`);
    }
    console.log(
      accepting.length > 0
        ? `delivered to: ${accepting.sort().join(", ")}`
        : "no installed harness accepts injected skills",
    );
  }
  return { status: 0 };
}
