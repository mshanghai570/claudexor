/**
 * The `harness` command's surface, kept beside its installable set so ONE
 * array spells that set everywhere it is printed: the registry usage line,
 * the dispatcher's usage error (harness-command.ts) and the installer's own
 * refusal (harness-installer.ts). This module stays value-import-free on
 * purpose — harness-installer.ts reaches command-registry.ts through args.ts,
 * so owning the array there would close a runtime import cycle.
 */
import type { CliCommandSpec } from "./command-registry.js";

/** Vendor CLIs `claudexor harness install` can fetch. harness-installer.ts
 * owns each one's install recipe and its test asserts this list is exhaustive. */
export const INSTALLABLE_HARNESSES = ["agy", "claude", "codex", "cursor", "opencode"] as const;

/** The `harness` argument shape: rendered by `claudexor help` and reprinted by
 * the dispatcher when a verb is unknown. `add` registers a config-declared
 * external agent CLI (a preset id, or a custom id behind `--command`). */
export const HARNESS_USAGE_ARGS = `list [--all] | install <${INSTALLABLE_HARNESSES.join("|")}> [--target <local|remote>] [--dry-run] [--yes] | add [preset|id] [--command <bin>] [--arg=<token>]... [--model-arg=<token>]... [--stream jsonl|text] [--key-env <VAR>] [--display-name <name>] | remove <id>`;

export const HARNESS_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "harness",
    positionalPatterns: [
      { prefix: ["list"], min: 1, max: 1 },
      { prefix: ["install"], min: 2, max: 2 },
      { prefix: ["add"], min: 1, max: 1 },
      { prefix: ["add"], min: 2, max: 2 },
      { prefix: ["remove"], min: 2, max: 2 },
    ],
    usageArgs: HARNESS_USAGE_ARGS,
    summary:
      "List harnesses, install a vendor CLI, or add/remove a config-declared external agent CLI",
    flags: [
      "all",
      "target",
      "dry-run",
      "yes",
      "command",
      "arg",
      "model-arg",
      "stream",
      "key-env",
      "display-name",
      "json",
    ],
    subcommandFlags: {
      list: ["all"],
      install: ["target", "dry-run", "yes"],
      add: ["command", "arg", "model-arg", "stream", "key-env", "display-name"],
      remove: [],
    },
    mutability: "ops",
    stability: "stable",
  },
];
