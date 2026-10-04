import type {
  AccessProfile,
  ConformanceReport,
  ExternalHarnessConfig,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
  Intent,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  AccessProfileIncompatibleError,
  HarnessUnavailableError,
  promptWithInstructions,
  providerScrubEnv,
  runCapture,
  runCliHarness,
} from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, redactSecrets } from "@claudexor/util";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { externalTextEvent, parseExternalEvent } from "./parse.js";

/**
 * Config-declared external agent CLI adapter (Cline, Gemini CLI, Kilo, Copilot,
 * Aider, Grok, Devin, Mistral Vibe, ...).
 *
 * ONE generic adapter interprets a `global.external_harnesses` row: it spawns
 * the declared command with the declared argv, feeds it the prompt, and parses
 * the declared stdout shape. Adding a tool therefore costs a config row, never
 * a package — the same config-driven shape `providerAdapters()` established for
 * OpenAI-compatible HTTP endpoints.
 *
 * Honesty rules inherited from the in-tree adapters:
 * - `discover()` refuses when the executable cannot be resolved (a broken
 *   install is named, not silently "unavailable");
 * - `doctor()` never claims `ok` on presence alone: `ok` requires the row's
 *   `auth_probe` to exit 0, exactly as an authenticated native CLI proves its
 *   own login. Without a probe the best honest verdict is `degraded`;
 * - an access profile the row does not declare is refused with a typed error
 *   instead of being silently downgraded to a wider one.
 */

/** Every canonical intent; the generic adapter declares the full general-agent
 * capability set, so doctor bookkeeping always splits this list into exactly
 * one of enabled/disabled. */
const ALL_INTENTS: Intent[] = [
  "plan",
  "spec",
  "implement",
  "create_from_scratch",
  "repair",
  "review",
  "verify",
  "synthesize",
  "explain",
  "audit",
];

const ACCESS_PROFILES: AccessProfile[] = ["readonly", "workspace_write", "full", "inherit_native"];

const VERSION_TIMEOUT_MS = 10_000;
const AUTH_PROBE_TIMEOUT_MS = 45_000;

/** Resolve the declared command to something spawnable: an absolute/relative
 * path must be an executable file, a bare name must sit on PATH. */
export function resolveExecutable(
  command: string,
  env: Record<string, string | null | undefined> = process.env,
): string | null {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [command]
      : (env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile() && existsSync(candidate)) return candidate;
    } catch {
      // Unreadable candidate: keep scanning PATH.
    }
  }
  return null;
}

async function detectVersion(
  command: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  try {
    const r = await runCapture(command, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS, env });
    const line = (r.stdout || r.stderr).split("\n").find((l) => l.trim());
    return line?.trim() ?? null;
  } catch {
    return null;
  }
}

function keyFor(
  cfg: ExternalHarnessConfig,
  env: Record<string, string | null | undefined>,
): string | null {
  if (!cfg.key_env) return null;
  return env[cfg.key_env] ?? process.env[cfg.key_env] ?? resolveSecret(cfg.key_env) ?? null;
}

/** Access profiles this row can honor. An EMPTY `access_args` means the CLI's
 * own native behavior is accepted for every profile; a non-empty record
 * declares exactly which profiles it can honor. */
function supportedAccess(cfg: ExternalHarnessConfig): AccessProfile[] {
  const declared = ACCESS_PROFILES.filter((profile) => cfg.access_args[profile] !== undefined);
  return declared.length > 0 ? declared : ACCESS_PROFILES;
}

function doctorEnv(cfg: ExternalHarnessConfig, spec: DoctorSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...spec.env, ...cfg.env })) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

export function createExternalHarnessAdapter(cfg: ExternalHarnessConfig): HarnessAdapter {
  const id = cfg.id;
  const hasKey = cfg.key_env !== null;
  const allDisabled = (reasons: string[]): ConformanceReport =>
    ConformanceReportSchema.parse({
      harness_id: id,
      status: "unavailable",
      checks: [],
      enabled_intents: [],
      disabled_intents: ALL_INTENTS,
      reasons,
      auth_sources: [],
    });

  return {
    id,

    async discover(): Promise<HarnessManifest> {
      const env = { ...process.env };
      if (resolveExecutable(cfg.command, env) === null) {
        throw new HarnessUnavailableError(
          `${cfg.command} not found on PATH (external harness "${id}") — install ${cfg.display_name} or point external_harnesses.${id}.command at its executable`,
        );
      }
      const version = (await detectVersion(cfg.command, env)) ?? `${cfg.command} (version unknown)`;
      return HarnessManifestSchema.parse({
        id,
        display_name: cfg.display_name,
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: cfg.provider_family,
        capabilities: {
          // The generic row declares the general agent surface: these are
          // ABILITIES (the CLI can plan/implement/review like any coding
          // agent); auth readiness lives in auth_modes and doctor.
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // No browser-MCP injection path exists for a config-declared row —
          // honest false until one does.
          browser_tool: false,
          web_policy: "uncontrolled",
          // No schema-constrained transport is declared for third-party CLIs:
          // the work_state axis stays unverified, a disclosed absence.
          work_report_transport: "unsupported",
          // No effort flag is declared generically; effort is not tunable.
          effort_levels: [],
          // We cannot enumerate a third-party CLI's model menu, so an absence
          // from our lists proves nothing: explicit models are forwarded and
          // disclosed instead of refused (INV-104 advisory).
          model_inventory_absence: "advisory",
        },
        capability_profile: {
          auth: {
            supported_sources: hasKey ? ["api_key_env"] : ["native_session"],
            preferred_source: null,
            credential_transports: hasKey
              ? [{ source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"] }]
              : [],
          },
          // Permission behavior comes from the row's access_args declaration;
          // the adapter itself enforces no scoped mechanism of its own.
          access_control: { readonly_mechanism: "none", write_mechanism: "none" },
          isolation: { supported_containment: ["env_or_file_injection"] },
          attachment_inputs: [],
        },
        auth_modes: hasKey ? ["api_key"] : ["local_session"],
        access_profiles_supported: supportedAccess(cfg),
      });
    },

    async doctor(spec: DoctorSpec): Promise<ConformanceReport> {
      const env = doctorEnv(cfg, spec);
      const installed = resolveExecutable(cfg.command, env);
      const requestedSource = spec.authSource;
      const supportedSource = hasKey ? "api_key_env" : "native_session";
      const installedCheck = installed
        ? {
            id: "installed",
            status: "pass" as const,
            detail: redactSecrets((await detectVersion(cfg.command, env)) ?? cfg.command),
          }
        : {
            id: "installed",
            status: "fail" as const,
            detail: `${cfg.command} not found on PATH (external harness "${id}")`,
          };

      if (requestedSource !== undefined && requestedSource !== supportedSource) {
        return ConformanceReportSchema.parse({
          harness_id: id,
          status: "unavailable",
          checks: [
            installedCheck,
            {
              id: "auth_source",
              status: "fail",
              detail: `${cfg.display_name} does not support ${requestedSource}`,
            },
          ],
          enabled_intents: [],
          disabled_intents: ALL_INTENTS,
          reasons: [
            ...(installed === null
              ? [
                  `${cfg.command} not found (install ${cfg.display_name} or fix external_harnesses.${id}.command)`,
                ]
              : []),
            `${cfg.display_name} does not support auth source ${requestedSource}`,
          ],
          auth_sources: [
            {
              source: requestedSource,
              availability: "unavailable",
              verification: "not_run",
              detail: `${cfg.display_name} does not support ${requestedSource}`,
            },
          ],
        });
      }

      if (installed === null) {
        return allDisabled([
          `${cfg.command} not found on PATH (install ${cfg.display_name} or fix external_harnesses.${id}.command)`,
        ]);
      }

      const key = keyFor(cfg, env);
      const keyReadiness =
        cfg.key_env === null
          ? {
              source: "native_session" as const,
              availability: "unknown" as const,
              verification: "not_run" as const,
              detail: `${cfg.display_name} uses its own login; Claudexor cannot verify it without an auth_probe row`,
            }
          : key !== null
            ? {
                source: "api_key_env" as const,
                availability: "available" as const,
                verification: "not_run" as const,
                detail: `credential slot ${cfg.key_env} is set (presence only; an auth_probe proves the route)`,
              }
            : {
                source: "api_key_env" as const,
                availability: "unavailable" as const,
                verification: "not_run" as const,
                detail: `no credential in ${cfg.key_env} (set it with \`claudexor secrets set ${cfg.key_env}\` or export it)`,
              };

      // A declared credential slot with nothing in it is a DISCLOSURE, not a
      // dead end: the row may still authenticate through the CLI's own login,
      // so the verdict stays degraded (runs allowed, gap clearly named) instead
      // of locking the operator out until they decode an unavailable verdict.
      const credentialGap =
        cfg.key_env !== null && key === null ? [`no credential in ${cfg.key_env}`] : [];

      if (cfg.auth_probe !== null && cfg.auth_probe.length > 0) {
        const probe = await runCapture(cfg.command, cfg.auth_probe, {
          timeoutMs: AUTH_PROBE_TIMEOUT_MS,
          cwd: spec.cwd,
          env,
        });
        const passed = probe.code === 0 && probe.signal === null;
        const detail = redactSecrets(
          (passed ? probe.stdout : probe.stderr || probe.stdout).trim().slice(0, 500),
        );
        if (!passed) {
          // A probe that fails does NOT lock the harness out: the same exit code
          // means "not authenticated" for one CLI and "probe flags drifted" for
          // another, so the honest verdict is degraded (runs allowed, the CLI
          // reports its own auth errors) with the probe output as the reason.
          return ConformanceReportSchema.parse({
            harness_id: id,
            status: "degraded",
            checks: [
              installedCheck,
              {
                id: "auth_probe",
                status: "fail",
                detail: `${cfg.command} ${cfg.auth_probe.join(" ")} exited ${probe.code ?? "by signal"}${detail ? `: ${detail}` : ""}`,
              },
            ],
            enabled_intents: ALL_INTENTS,
            disabled_intents: [],
            reasons: [
              `auth probe did not prove authentication (exit ${probe.code ?? probe.signal})`,
              ...credentialGap,
              ...(detail ? [detail] : []),
            ],
            auth_sources: [{ ...keyReadiness, verification: "failed" }],
          });
        }
        return ConformanceReportSchema.parse({
          harness_id: id,
          status: "ok",
          checks: [
            installedCheck,
            { id: "auth_probe", status: "pass", detail: detail || "auth probe exited 0" },
          ],
          enabled_intents: ALL_INTENTS,
          disabled_intents: [],
          reasons: [],
          auth_sources: [{ ...keyReadiness, verification: "passed" }],
        });
      }

      // No probe declared: presence (or an unverifiable native login) can only
      // be reported as degraded, and the reasons say exactly how to reach ok.
      return ConformanceReportSchema.parse({
        harness_id: id,
        status: "degraded",
        checks: [
          installedCheck,
          {
            id: "provider_auth",
            status: cfg.key_env === null ? "skip" : key !== null ? "pass" : "fail",
            detail: keyReadiness.detail!,
          },
          {
            id: "auth_probe",
            status: "skip",
            detail: "no auth_probe declared for this external harness",
          },
        ],
        enabled_intents: ALL_INTENTS,
        disabled_intents: [],
        reasons: [
          ...credentialGap,
          cfg.key_env === null
            ? `${cfg.display_name} login cannot be proven without an auth_probe; runs are allowed and the CLI reports its own auth errors`
            : `credential present but unproven (no auth_probe); declare auth_probe on external_harnesses.${id} to reach doctor-ok`,
        ],
        auth_sources: [keyReadiness],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runExternal(cfg, spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runExternal(cfg, spec);
    },
  };
}

async function* runExternal(
  cfg: ExternalHarnessConfig,
  spec: HarnessRunSpec,
): AsyncIterable<HarnessEvent> {
  const declared = supportedAccess(cfg);
  if (!declared.includes(spec.access)) {
    throw new AccessProfileIncompatibleError(
      `${cfg.display_name} does not declare a "${spec.access}" access profile (declared: ${declared.join(", ")}); add access_args.${spec.access} to external_harnesses.${cfg.id} or choose a harness that supports it`,
    );
  }

  const args = [...cfg.args, ...(cfg.access_args[spec.access] ?? [])];
  if (spec.model_hint && cfg.model_args.length > 0) {
    for (const token of cfg.model_args) args.push(token.replace(/\{model\}/g, spec.model_hint));
  }
  const prompt = promptWithInstructions(spec);
  const promptIndex = args.findIndex((token) => token.includes("{prompt}"));
  if (promptIndex >= 0) {
    // A placeholder may sit inside a larger token (`--prompt={prompt}`), so
    // substitute textually rather than requiring an exact-match token.
    args[promptIndex] = args[promptIndex].split("{prompt}").join(prompt);
  } else {
    args.push(prompt);
  }

  // Same unified provider scrub every adapter applies: clear EVERY known
  // provider secret, then re-add only this row's own credential.
  const env: Record<string, string | null | undefined> = {
    ...spec.env,
    ...providerScrubEnv(),
    ...cfg.env,
  };
  const key = keyFor(cfg, { ...process.env, ...spec.env, ...cfg.env });
  if (cfg.key_env !== null && key !== null) env[cfg.key_env] = key;

  yield* runCliHarness({
    bin: cfg.command,
    args,
    spec,
    env,
    label: cfg.display_name,
    redact: redactSecrets,
    parseEvent: (obj, sessionId) => {
      const out = parseExternalEvent(obj, sessionId);
      stampRoute(out, cfg, spec.credential_profile);
      return out;
    },
    ...(cfg.stream === "text"
      ? {
          parseLine: (line: string, sessionId: string) => {
            const out = externalTextEvent(line, sessionId);
            stampRoute(out, cfg, spec.credential_profile);
            return out;
          },
        }
      : {}),
  });
}

/** Stamp the credential route this run actually rides, so the attempt's auth
 * receipt stays attributable (managed key vs. the CLI's own login). */
function stampRoute(
  events: HarnessEvent[] | null,
  cfg: ExternalHarnessConfig,
  profile: HarnessRunSpec["credential_profile"],
): void {
  if (!events) return;
  for (const ev of events) {
    if (cfg.key_env !== null) {
      ev.credential_route = "managed_api_key";
      ev.credential_source = "api_key_env";
    } else {
      ev.credential_route = "vendor_native";
      ev.credential_source = "native_session";
    }
    if (profile) ev.credential_profile_id = profile.profile_id;
  }
}
