import type { ExtraMcpServer, GlobalConfig, Intent, PaidBudget } from "@claudexor/schema";
import { DELEGATION_ENV } from "@claudexor/util";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import { isFullAccess } from "./requestRequirements.js";

/** The delegation belt's reserved server name; user servers may not take it. */
const BELT_SERVER_NAME = "claudexor";

/**
 * User-defined MCP servers from config, injected into every harness run's
 * sandbox alongside the delegation belt. A name colliding with the belt (or a
 * duplicate) is dropped with a warning — config errors must not fail runs;
 * `claudexor mcp list` reports them instead.
 */
export function userMcpServersFor(config: GlobalConfig | undefined): ExtraMcpServer[] {
  const rows = config?.mcp?.servers ?? [];
  const out: ExtraMcpServer[] = [];
  const seen = new Set<string>([BELT_SERVER_NAME]);
  for (const s of rows) {
    if (seen.has(s.name)) {
      console.error(
        `[claudexor] ignoring MCP server "${s.name}": the name is reserved${seen.has(BELT_SERVER_NAME) && s.name === BELT_SERVER_NAME ? " by the delegation belt" : " or duplicated"}`,
      );
      continue;
    }
    seen.add(s.name);
    out.push({
      name: s.name,
      command: s.command,
      args: s.args,
      env: s.env,
      required: s.required,
    });
  }
  return out;
}

/**
 * The extra MCP servers injected into one agent lane's sandbox: the delegation
 * belt (D32; present when `--delegate` is on, the daemon built a belt
 * descriptor, the lane's adapter can inject MCP servers, and the lane is a
 * WRITING agent intent — the delegator integrates results in its workspace;
 * read lanes and reviewers have nothing to delegate) plus the user's
 * config-defined servers (present on every lane whose adapter can inject).
 */
export function delegationBeltFor(
  input: RunInput | undefined,
  intent: Intent,
  routed: RoutedAdapter,
  resolvedBudget: PaidBudget,
): ExtraMcpServer[] {
  if (
    !input?.delegate ||
    !input.delegationBelt ||
    !input.delegationParentRunId ||
    !routed.delegationRequirement.effective
  )
    return [];
  // A lane that sandbox-cancels the belt below full access (codex) must NOT
  // receive a belt it cannot use. Per-lane requirement resolution records the
  // typed degradation, while a mixed pool keeps the belt on lanes that can
  // host it.
  if (routed.mcpInjectionRequiresFullAccess && !isFullAccess(routed.adapterAccess)) return [];
  const writingIntents: Intent[] = ["implement", "create_from_scratch", "repair"];
  if (!writingIntents.includes(intent)) return [];
  // The CLI built the descriptor from the RAW request budget (undefined when
  // the caller relied on a config/dep default), which would leave the belt
  // unlimited while the real run is capped. Rebind the belt's parent-budget
  // env to the RESOLVED budget (resolvePaidBudget output) so sub-run draws are
  // bounded by the same headroom the parent run enforces — one budget owner.
  const env = { ...input.delegationBelt.env };
  for (const [key, value] of [
    [DELEGATION_ENV.processingPreference, input.processingPreference],
    [DELEGATION_ENV.workspaceKind, input.workspaceKind],
    [
      DELEGATION_ENV.scopePaths,
      input.scopePaths === undefined ? undefined : JSON.stringify(input.scopePaths),
    ],
  ]) {
    if (value === undefined) delete env[key!];
    else env[key!] = value;
  }
  return [
    {
      ...input.delegationBelt,
      env: {
        ...env,
        [DELEGATION_ENV.parentRunId]: input.delegationParentRunId,
        [DELEGATION_ENV.repoRoot]: input.repoRoot,
        [DELEGATION_ENV.budget]: JSON.stringify(resolvedBudget),
      },
    },
  ];
}

/**
 * The FULL extra-MCP-server set for one lane: the delegation belt (when
 * eligible, above) plus the user's config-defined MCP servers. Belt-eligible
 * lanes are checked first so the belt's reserved name cannot be shadowed by a
 * user row; user servers ride every MCP-capable lane regardless of intent.
 */
export function extraMcpServersFor(
  input: RunInput | undefined,
  intent: Intent,
  routed: RoutedAdapter,
  resolvedBudget: PaidBudget,
  config: GlobalConfig | undefined,
): ExtraMcpServer[] {
  const belt = delegationBeltFor(input, intent, routed, resolvedBudget);
  const userServers = userMcpServersFor(config);
  const beltNames = new Set(belt.map((s) => s.name));
  return [...belt, ...userServers.filter((s) => !beltNames.has(s.name))];
}
