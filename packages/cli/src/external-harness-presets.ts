/**
 * Presets for `claudexor harness add <preset>` — the config-declared external
 * agent CLIs (Cline, Gemini CLI, Kilo, Copilot, Aider, Grok Build, Devin,
 * Mistral Vibe). Each preset is exactly one `global.external_harnesses` row:
 * adding a tool costs config, never adapter source.
 *
 * Flag provenance is disclosed per preset: rows marked `unverified` were built
 * from vendor documentation rather than a live `--help` on this host, and a
 * wrong flag surfaces as the CLI's own usage error on the run (never a silent
 * success). Presets are starting points — every field is editable in
 * `~/.claudexor/v3/config.yaml`.
 */
import type { ExternalHarnessConfig } from "@claudexor/schema";
import {
  ExternalHarnessConfig as ExternalHarnessConfigSchema,
  type ExternalHarnessConfigInput,
} from "@claudexor/schema";
import { updateGlobalConfig } from "@claudexor/config";

export interface ExternalHarnessPreset {
  readonly id: string;
  readonly summary: string;
  readonly row: ExternalHarnessConfig;
  /** True when the flags came from vendor docs, not a live `--help` here. */
  readonly unverified?: boolean;
}

const row = (input: ExternalHarnessConfigInput): ExternalHarnessConfig =>
  ExternalHarnessConfigSchema.parse(input);

/** A tiny paid probe keeps doctor honest: exit 0 proves the vendor answered. */
const ONE_WORD_PROBE = "Reply with the single word OK";

export const EXTERNAL_HARNESS_PRESETS: readonly ExternalHarnessPreset[] = [
  {
    id: "gemini",
    summary: "Gemini CLI (headless stream-json; native login or GEMINI_API_KEY)",
    row: row({
      id: "gemini",
      display_name: "Gemini CLI",
      command: "gemini",
      args: ["--skip-trust", "-o", "stream-json", "-p", "{prompt}"],
      model_args: ["-m", "{model}"],
      stream: "jsonl",
      key_env: "GEMINI_API_KEY",
      auth_probe: ["--skip-trust", "-o", "json", "-p", ONE_WORD_PROBE],
      access_args: {
        readonly: ["--approval-mode", "plan"],
        workspace_write: ["--approval-mode", "auto_edit"],
        full: ["--approval-mode", "yolo"],
        inherit_native: [],
      },
      provider_family: "google",
    }),
  },
  {
    id: "cline",
    summary: "Cline CLI (JSON messages; credentials managed by cline auth)",
    row: row({
      id: "cline",
      display_name: "Cline CLI",
      command: "cline",
      args: ["--json", "{prompt}"],
      model_args: ["-m", "{model}"],
      stream: "jsonl",
      key_env: null,
      auth_probe: ["--json", ONE_WORD_PROBE],
      access_args: {
        // `-p` is Cline's plan mode (read-only); empty = its native policy.
        readonly: ["-p"],
        workspace_write: [],
        full: ["--auto-approve", "true"],
        inherit_native: [],
      },
    }),
  },
  {
    id: "copilot",
    summary: "GitHub Copilot CLI (JSONL events; `copilot auth login` or a token)",
    row: row({
      id: "copilot",
      display_name: "GitHub Copilot CLI",
      command: "copilot",
      args: ["--output-format", "json", "-p", "{prompt}"],
      model_args: ["--model", "{model}"],
      stream: "jsonl",
      key_env: null,
      auth_probe: ["--output-format", "json", "-p", ONE_WORD_PROBE],
      access_args: {
        // No verified read-only mode: read-only runs route elsewhere.
        workspace_write: [],
        full: ["--allow-all"],
        inherit_native: [],
      },
    }),
  },
  {
    id: "kilo",
    summary: "Kilo Code CLI (OpenCode-lineage `run --format json`)",
    row: row({
      id: "kilo",
      display_name: "Kilo Code CLI",
      command: "kilo",
      args: ["run", "--format", "json", "{prompt}"],
      model_args: ["-m", "{model}"],
      stream: "jsonl",
      key_env: null,
      auth_probe: ["auth", "list"],
      access_args: {
        workspace_write: [],
        full: ["--dangerously-skip-permissions"],
        inherit_native: [],
      },
    }),
  },
  {
    id: "aider",
    summary: "Aider (plain-text one-shot via --message; key from OPENAI_API_KEY)",
    row: row({
      id: "aider",
      display_name: "Aider",
      command: "aider",
      args: ["--no-auto-commits", "--message", "{prompt}"],
      model_args: ["--model", "{model}"],
      stream: "text",
      key_env: "OPENAI_API_KEY",
      auth_probe: null,
      access_args: {
        workspace_write: ["--yes-always"],
        full: ["--yes-always"],
        inherit_native: [],
      },
    }),
  },
  {
    id: "grok",
    summary: "Grok Build (headless streaming-json; `grok login` or XAI_API_KEY)",
    row: row({
      id: "grok",
      display_name: "Grok Build",
      command: "grok",
      args: ["--no-auto-update", "--output-format", "streaming-json", "-p", "{prompt}"],
      model_args: ["-m", "{model}"],
      stream: "jsonl",
      key_env: "XAI_API_KEY",
      auth_probe: ["--no-auto-update", "--output-format", "json", "-p", ONE_WORD_PROBE],
      access_args: {
        workspace_write: [],
        full: ["--always-approve"],
        inherit_native: [],
      },
      provider_family: "xai",
    }),
  },
  {
    id: "devin",
    summary: "Devin CLI (print mode: `devin -p -- <prompt>`)",
    unverified: true,
    row: row({
      id: "devin",
      display_name: "Devin CLI",
      command: "devin",
      args: ["-p", "--", "{prompt}"],
      model_args: [],
      stream: "text",
      key_env: null,
      auth_probe: null,
      access_args: {
        workspace_write: [],
        full: ["--permission-mode", "dangerous"],
        inherit_native: [],
      },
    }),
  },
  {
    id: "vibe",
    summary: "Mistral Vibe (`vibe --prompt`; MISTRAL_API_KEY or Mistral login)",
    unverified: true,
    row: row({
      id: "vibe",
      display_name: "Mistral Vibe",
      command: "vibe",
      args: ["--prompt", "{prompt}"],
      model_args: [],
      stream: "text",
      key_env: "MISTRAL_API_KEY",
      auth_probe: null,
      access_args: {
        workspace_write: ["--auto-approve"],
        full: ["--auto-approve"],
        inherit_native: [],
      },
    }),
  },
];

export function externalHarnessPreset(id: string): ExternalHarnessPreset | undefined {
  return EXTERNAL_HARNESS_PRESETS.find((preset) => preset.id === id);
}

/** Append one row; the config schema is the single validator (ids, duplicates,
 * built-in collisions) so this never writes a row runs would reject later. */
export function addExternalHarnessRow(row: ExternalHarnessConfig): void {
  updateGlobalConfig((config) => {
    const existing = config.external_harnesses ?? [];
    if (existing.some((entry) => entry.id === row.id)) {
      throw new Error(
        `external harness "${row.id}" already exists — edit ~/.claudexor/v3/config.yaml or \`claudexor harness remove ${row.id}\` first`,
      );
    }
    return { ...config, external_harnesses: [...existing, row] };
  });
}

export function removeExternalHarnessRow(id: string): void {
  updateGlobalConfig((config) => {
    const existing = config.external_harnesses ?? [];
    if (!existing.some((entry) => entry.id === id)) {
      throw new Error(`no external harness "${id}" configured`);
    }
    return { ...config, external_harnesses: existing.filter((entry) => entry.id !== id) };
  });
}
