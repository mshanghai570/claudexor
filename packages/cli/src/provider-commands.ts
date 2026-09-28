/**
 * `claudexor providers` — manage user-defined OpenAI-compatible providers.
 *
 * Each row registers a raw-API harness (id `provider-<name>`) backed by any
 * endpoint speaking the OpenAI chat-completions contract. The API key is a
 * SECRET: `claudexor providers add` records the row and prints the exact
 * `claudexor secrets set` command — it never accepts or stores key material.
 */
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import type { ParsedArgs } from "./args.js";
import { printJson } from "./cli-io.js";

interface ProviderRow {
  name: string;
  base_url: string;
  key_env: string;
  default_model: string | null;
  usage_cost_unit: "usd" | null;
}

const USAGE =
  "usage: claudexor providers [list] | add <name> <base-url> <key-env> [model] | remove <name>";

export function providersCommand(args: ParsedArgs, json: boolean): { status: number } {
  const sub = args._[1];
  const rest = args._.slice(2);

  if (sub === "list" || sub === undefined) {
    const rows = readProviders();
    if (json) {
      printJson({ ok: true, providers: rows });
    } else {
      if (rows.length === 0) {
        console.log("no providers configured — add one with `claudexor providers add`");
        return { status: 0 };
      }
      for (const p of rows) {
        console.log(
          `${p.name}  ${p.base_url}  key=${p.key_env}  model=${p.default_model ?? "(endpoint default)"}  harness=provider-${p.name}`,
        );
      }
    }
    return { status: 0 };
  }

  if (sub === "add") {
    const [name, baseUrl, keyEnv] = rest;
    if (!name || !baseUrl || !keyEnv) {
      return usage(json, "usage: claudexor providers add <name> <base-url> <key-env> [model]");
    }
    const model = rest[3] ?? null;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return usage(json, `invalid provider name "${name}": lowercase alphanumeric/hyphen only`);
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      return usage(json, `invalid base URL "${baseUrl}": must be an http(s) URL`);
    }
    try {
      updateGlobalConfig((config) => {
        const existing = config.providers ?? [];
        if (existing.some((p) => p.name === name)) {
          throw new Error(`provider "${name}" already exists`);
        }
        if (existing.some((p) => p.key_env === keyEnv)) {
          throw new Error(`key_env "${keyEnv}" is already used by another provider`);
        }
        const row: ProviderRow = {
          name,
          base_url: baseUrl,
          key_env: keyEnv,
          default_model: model,
          usage_cost_unit: null,
        };
        return { ...config, providers: [...existing, row] };
      });
    } catch (err) {
      return usage(json, err instanceof Error ? err.message : String(err));
    }
    if (json) {
      printJson({
        ok: true,
        provider: name,
        harnessId: `provider-${name}`,
        nextStep: `claudexor secrets set ${keyEnv} --from-env <ENV_VAR>`,
      });
    } else {
      console.log(`provider "${name}" added (harness id: provider-${name})`);
      console.log(`next: claudexor secrets set ${keyEnv} --from-env <ENV_VAR_HOLDING_YOUR_KEY>`);
      console.log(`then: claudexor agent "<task>" --harness provider-${name}`);
    }
    return { status: 0 };
  }

  if (sub === "remove") {
    const [name] = rest;
    if (!name) return usage(json, "usage: claudexor providers remove <name>");
    try {
      updateGlobalConfig((config) => {
        const existing = config.providers ?? [];
        if (!existing.some((p) => p.name === name)) {
          throw new Error(`no such provider "${name}"`);
        }
        return { ...config, providers: existing.filter((p) => p.name !== name) };
      });
    } catch (err) {
      return usage(json, err instanceof Error ? err.message : String(err));
    }
    if (json) printJson({ ok: true, removed: name });
    else console.log(`provider "${name}" removed`);
    return { status: 0 };
  }

  return usage(json, USAGE);
}

function usage(json: boolean, message: string): { status: number } {
  if (json) printJson({ ok: false, error: message });
  else console.error(message);
  return { status: 2 };
}

/** The strict parse path, so the listing reflects exactly what runs see. */
function readProviders(): ProviderRow[] {
  try {
    return loadConfig(process.cwd()).global.providers ?? [];
  } catch {
    return [];
  }
}
