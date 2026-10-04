import { z } from "zod/v3";
import { NonBlankString, ProviderFamily } from "./primitives.js";

/**
 * Harness ids the engine owns. A user-declared external harness may not take
 * one of these names: the registry registers both, and a duplicate key would
 * silently shadow a built-in (one owner per id, listed once).
 */
export const RESERVED_HARNESS_IDS: ReadonlySet<string> = new Set([
  "codex",
  "agy",
  "claude",
  "cursor",
  "opencode",
  "raw-api",
  "openrouter",
]);

/**
 * One user-declared external agent CLI (Cline, Gemini CLI, Kilo, Copilot,
 * Aider, Grok, Devin, Mistral Vibe, ...). Exported on its own so the adapter
 * package and the `claudexor harness add` command share ONE row shape with the
 * config that persists it.
 */
export const ExternalHarnessConfig = z
  .object({
    id: NonBlankString.regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "external harness id must be lowercase alphanumeric/hyphen",
    ).describe("Harness id (e.g. gemini, cline, copilot); also the `--harness` selector."),
    display_name: NonBlankString.describe("Human-facing name shown in harness lists."),
    command: NonBlankString.describe(
      "Executable for the CLI, resolved via PATH (absolute path also accepted).",
    ),
    args: z
      .array(z.string())
      .default([])
      .describe(
        "Argv tokens passed before the prompt. A {prompt} placeholder (whole token or inside one) places the prompt there; without it the prompt is appended last.",
      ),
    model_args: z
      .array(z.string())
      .default([])
      .describe(
        "Argv tokens inserted before the prompt when the run pins a model; {model} is substituted for the model id.",
      ),
    stream: z
      .enum(["jsonl", "text"])
      .default("jsonl")
      .describe(
        "How the CLI writes stdout: jsonl = one JSON object per line (parsed into harness events), text = plain prose lines (emitted as message events).",
      ),
    key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "key_env must be an env-var-style name")
      .nullable()
      .default(null)
      .describe(
        "Env var (or SecretStore slot) holding this CLI's API key; null = the CLI's own interactive login.",
      ),
    auth_probe: z
      .array(z.string())
      .nullable()
      .default(null)
      .describe(
        "Argv appended to `command` whose exit 0 PROVES authentication (e.g. auth status); null = auth cannot be proven, so the harness stays degraded and never claims doctor-ok.",
      ),
    env: z
      .record(z.string(), z.string())
      .default({})
      .describe("Extra environment variables exported for this CLI's processes."),
    access_args: z
      .record(
        z.enum(["readonly", "workspace_write", "full", "inherit_native"]),
        z.array(z.string()),
      )
      .default({})
      .describe(
        "Argv appended per requested access profile (the flags that make the CLI non-interactive under that profile). An EMPTY record means the CLI's own native behavior is accepted for every profile; a non-empty record declares exactly which profiles it can honor, and an undeclared profile is refused instead of silently downgraded.",
      ),
    provider_family: ProviderFamily.default("unknown").describe(
      "Vendor family for route-diversity reasoning.",
    ),
  })
  .strict();
export type ExternalHarnessConfig = z.infer<typeof ExternalHarnessConfig>;
/** The DECLARED row shape (defaults still optional) — what a preset or the
 * `claudexor harness add` command builds before it is parsed into a row. */
export type ExternalHarnessConfigInput = z.input<typeof ExternalHarnessConfig>;

/**
 * The whole `global.external_harnesses` key: rows plus their uniqueness and
 * built-in-collision checks, so config.ts keeps only the one-line reference
 * (the file's line cap) while this stays the single owner of the rules.
 */
export const ExternalHarnessList = z
  .array(ExternalHarnessConfig)
  .default([])
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (
        RESERVED_HARNESS_IDS.has(row.id) ||
        row.id.startsWith("fake-") ||
        row.id.startsWith("provider-")
      )
        ctx.addIssue({
          code: "custom",
          message: `external harness id ${row.id} collides with a built-in harness id; pick another id`,
        });
      if (seen.has(row.id))
        ctx.addIssue({ code: "custom", message: `duplicate external harness id ${row.id}` });
      seen.add(row.id);
    }
  })
  .describe(
    "User-defined external agent CLIs; each registers a harness usable as an AI agent without writing adapter code.",
  );
