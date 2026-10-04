import { flagBool, flagStr, flagStringList, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { subcommandFlagScopeError } from "./command-scope.js";
import {
  ExternalHarnessConfig as ExternalHarnessConfigSchema,
  type ExternalHarnessConfig,
  type ExternalHarnessConfigInput,
} from "@claudexor/schema";
import {
  EXTERNAL_HARNESS_PRESETS,
  addExternalHarnessRow,
  externalHarnessPreset,
  removeExternalHarnessRow,
} from "./external-harness-presets.js";
import { HARNESS_USAGE_ARGS } from "./harness-command-specs.js";
import { harnessInstallCommand } from "./harness-installer.js";
import { buildRegistry } from "./registry.js";

/**
 * `claudexor harness list [--all]`, `claudexor harness install <id>`, and the
 * config-declared external-harness verbs (`add`/`remove`). Fakes are test
 * fixtures, not real harnesses; `--all` reveals them. The install verb is the
 * target-aware disclosed installer (harness-installer.ts, issue #89): exact
 * npm pins for claude/codex/opencode, and for the script
 * vendors (cursor, agy) either the human-verified remote PTY path or, under an
 * explicit `--target local --yes`, receipt-bound unattended execution. Nothing
 * executes without disclosure and explicit authorization.
 * `add <preset>` writes one `global.external_harnesses` row — a config row is
 * the whole contract for an external agent CLI (Cline, Gemini, Kilo, ...), so
 * no adapter source is involved; `add <id> --command <bin>` does the same for
 * a tool with no preset.
 * Flags are verb-owned (registry `subcommandFlags`): `harness list --yes` or
 * `harness install --all` is a loud exit-2 usage error, never a silently
 * ignored flag (INV-021).
 */
export function harnessCommand(args: ParsedArgs, json: boolean): number {
  const sub = args._[1] ?? "";
  const scopeError = subcommandFlagScopeError("harness", sub, Object.keys(args.flags));
  if (scopeError) return printUsageError(json, scopeError);
  if (args._[1] === "list") {
    const includeFakes = flagBool(args, "all");
    const ids = [...buildRegistry({ includeFakes }).keys()];
    if (json) printJson({ harnesses: ids });
    else ids.forEach((id) => print(id));
    return 0;
  }
  if (args._[1] === "install") {
    return harnessInstallCommand(args, json);
  }
  if (args._[1] === "add") {
    return harnessAddCommand(args, json);
  }
  if (args._[1] === "remove") {
    return harnessRemoveCommand(args, json);
  }
  return printUsageError(json, `usage: claudexor harness ${HARNESS_USAGE_ARGS}`);
}

const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** `claudexor harness add` — no argument lists the shippable presets; with an
 * id it writes one config row (preset-backed, or custom behind `--command`). */
function harnessAddCommand(args: ParsedArgs, json: boolean): number {
  const id = args._[2];
  if (id === undefined) {
    if (json) {
      printJson({
        presets: EXTERNAL_HARNESS_PRESETS.map((preset) => ({
          id: preset.id,
          summary: preset.summary,
          unverified: preset.unverified === true,
        })),
      });
      return 0;
    }
    print(
      "config-declared external agent CLI presets (add one with `claudexor harness add <preset>`):",
    );
    for (const preset of EXTERNAL_HARNESS_PRESETS) {
      print(
        `  ${preset.id.padEnd(9)} ${preset.summary}${preset.unverified ? "  [verify flags]" : ""}`,
      );
    }
    print("");
    print("custom tool: claudexor harness add <id> --command <bin> [--arg=<token>]...");
    return 0;
  }
  if (!HARNESS_ID_PATTERN.test(id)) {
    return printUsageError(json, `invalid harness id "${id}": lowercase alphanumeric/hyphen only`);
  }
  const preset = externalHarnessPreset(id);
  let command = flagStr(args, "command") ?? preset?.row.command;
  if (command === undefined || command === "") {
    const known = EXTERNAL_HARNESS_PRESETS.map((entry) => entry.id).join(", ");
    return printUsageError(
      json,
      `"${id}" is not a preset (presets: ${known}) and no executable was given — pass --command <bin>`,
    );
  }
  let argTokens: string[];
  let modelTokens: string[];
  try {
    argTokens = flagStringList(args, "arg");
    modelTokens = flagStringList(args, "model-arg");
  } catch (err) {
    return printUsageError(json, err instanceof Error ? err.message : String(err));
  }
  const stream = flagStr(args, "stream") ?? preset?.row.stream ?? "jsonl";
  if (stream !== "jsonl" && stream !== "text") {
    return printUsageError(json, `invalid --stream "${stream}": jsonl or text only`);
  }
  const keyEnv = flagStr(args, "key-env");
  const input: ExternalHarnessConfigInput = {
    ...(preset?.row ?? {}),
    id,
    command,
    display_name: flagStr(args, "display-name") ?? preset?.row.display_name ?? id,
    args: argTokens.length > 0 ? argTokens : (preset?.row.args ?? []),
    model_args: modelTokens.length > 0 ? modelTokens : (preset?.row.model_args ?? []),
    stream,
    ...(keyEnv !== undefined ? { key_env: keyEnv } : {}),
  };
  let row: ExternalHarnessConfig;
  try {
    row = ExternalHarnessConfigSchema.parse(input);
    addExternalHarnessRow(row);
  } catch (err) {
    return printUsageError(json, err instanceof Error ? err.message : String(err));
  }
  if (json) {
    printJson({ ok: true, harness: row.id, preset: preset?.id ?? null, row });
    return 0;
  }
  print(`external harness "${row.id}" added (${row.display_name} → \`${row.command}\`)`);
  if (preset?.unverified) {
    print(
      `note: this preset's flags come from vendor docs — check \`${row.command} --help\` and edit ~/.claudexor/v3/config.yaml if the CLI disagrees.`,
    );
  }
  print(`next: claudexor doctor --harness ${row.id}`);
  print(`      claudexor agent "<task>" --harness ${row.id}`);
  print(
    `tip: set auth_probe on the row (argv whose exit 0 proves login) so Doctor can report ${row.id} as ready instead of unproven.`,
  );
  if (Object.keys(row.access_args).length === 0) {
    print(
      `note: ${row.id} accepts this CLI's native behavior under every access profile; declare access_args in ~/.claudexor/v3/config.yaml to pin per-profile flags (e.g. a read-only mode).`,
    );
  }
  print("note: restart the engine (claudexor daemon restart) to register a new harness.");
  return 0;
}

/** `claudexor harness remove <id>` — config rows only; built-in harnesses are
 * disabled through `harnesses.<id>.enabled: false`, never deleted. */
function harnessRemoveCommand(args: ParsedArgs, json: boolean): number {
  const id = args._[2] ?? "";
  if (!id) return printUsageError(json, `usage: claudexor harness remove <id>`);
  try {
    removeExternalHarnessRow(id);
  } catch (err) {
    return printUsageError(json, err instanceof Error ? err.message : String(err));
  }
  if (json) printJson({ ok: true, removed: id });
  else {
    print(`external harness "${id}" removed`);
    print("note: restart the engine (claudexor daemon restart) to unregister it.");
  }
  return 0;
}
