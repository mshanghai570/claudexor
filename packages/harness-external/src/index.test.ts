import { describe, expect, it } from "vitest";
import { ExternalHarnessConfig, HarnessRunSpec } from "@claudexor/schema";
import { AccessProfileIncompatibleError, HarnessUnavailableError } from "@claudexor/core";
import { createExternalHarnessAdapter, resolveExecutable } from "./index.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/** Node itself is a guaranteed-installed executable, so discovery/probes are
 * deterministic on every host (no vendor CLI required for these tests). */
const NODE = process.execPath;

function row(overrides: Record<string, unknown> = {}) {
  return ExternalHarnessConfig.parse({
    id: "ext-test",
    display_name: "External Test CLI",
    command: NODE,
    ...overrides,
  });
}

function spec(overrides: Record<string, unknown> = {}) {
  return HarnessRunSpec.parse({
    session_id: "ext-test-session",
    intent: "implement",
    prompt: "PROMPT-TOKEN",
    cwd: process.cwd(),
    access: "full",
    external_context_policy: "auto",
    tool_permission_policy: { web: "auto", allow: [], deny: [] },
    ...overrides,
  });
}

describe("resolveExecutable", () => {
  it("accepts an absolute executable and rejects a missing bare name", () => {
    expect(resolveExecutable(NODE)).toBe(NODE);
    expect(resolveExecutable("claudexor-definitely-not-a-binary")).toBeNull();
  });

  it("resolves a bare name through a provided PATH", () => {
    const { basename, dirname } = {
      basename: NODE.split("/").pop()!,
      dirname: NODE.slice(0, NODE.lastIndexOf("/")),
    };
    expect(resolveExecutable(basename, { PATH: dirname })).toBe(NODE);
  });
});

describe("discover", () => {
  it("declares an advisory model inventory so an explicit model is forwarded, not refused", async () => {
    const manifest = await createExternalHarnessAdapter(row()).discover();
    expect(manifest).toMatchObject({
      id: "ext-test",
      display_name: "External Test CLI",
      kind: "local_cli",
      provider_family: "unknown",
    });
    expect(manifest.capabilities.model_inventory_absence).toBe("advisory");
    expect(manifest.auth_modes).toEqual(["local_session"]);
  });

  it("refuses when the declared command cannot be resolved", async () => {
    const adapter = createExternalHarnessAdapter(
      row({ command: "claudexor-missing-external-cli" }),
    );
    await expect(adapter.discover()).rejects.toThrow(HarnessUnavailableError);
    await expect(adapter.discover()).rejects.toThrow(/not found on PATH/);
  });

  it("declares exactly the access profiles the row can honor", async () => {
    const manifest = await createExternalHarnessAdapter(
      row({ access_args: { full: ["--yes"], readonly: ["--plan"] } }),
    ).discover();
    expect(manifest.access_profiles_supported.sort()).toEqual(["full", "readonly"]);
  });
});

describe("doctor", () => {
  it("is degraded (never ok) without an auth_probe, and keeps every intent runnable", async () => {
    const report = await createExternalHarnessAdapter(row()).doctor({ cwd: process.cwd() });
    expect(report.status).toBe("degraded");
    expect(report.enabled_intents.length).toBeGreaterThan(0);
    expect(report.disabled_intents).toEqual([]);
    expect(report.reasons.join(" ")).toContain("auth_probe");
  });

  it("reaches ok when the declared auth probe exits 0", async () => {
    const adapter = createExternalHarnessAdapter(row({ auth_probe: ["-e", "process.exit(0)"] }));
    const report = await adapter.doctor({ cwd: process.cwd() });
    expect(report.status).toBe("ok");
    expect(report.auth_sources[0]).toMatchObject({ verification: "passed" });
    expect(report.enabled_intents.length).toBeGreaterThan(0);
  });

  it("stays degraded (never unavailable) when the probe fails, naming the failure", async () => {
    const adapter = createExternalHarnessAdapter(row({ auth_probe: ["-e", "process.exit(3)"] }));
    const report = await adapter.doctor({ cwd: process.cwd() });
    expect(report.status).toBe("degraded");
    expect(report.auth_sources[0]).toMatchObject({ verification: "failed" });
    expect(report.reasons.join(" ")).toContain("exit 3");
    // Still routable: a misconfigured probe must not lock the operator out.
    expect(report.enabled_intents.length).toBeGreaterThan(0);
  });

  it("reports a missing declared credential as a named gap, still degraded", async () => {
    const adapter = createExternalHarnessAdapter(
      row({ key_env: "CLAUDEXOR_TEST_ABSENT_EXTERNAL_KEY" }),
    );
    const report = await adapter.doctor({ cwd: process.cwd() });
    expect(report.status).toBe("degraded");
    expect(report.auth_sources[0]).toMatchObject({
      source: "api_key_env",
      availability: "unavailable",
    });
    expect(report.reasons.join(" ")).toContain(
      "no credential in CLAUDEXOR_TEST_ABSENT_EXTERNAL_KEY",
    );
  });

  it("refuses an auth source the row does not support", async () => {
    const adapter = createExternalHarnessAdapter(row());
    const report = await adapter.doctor({ cwd: process.cwd(), authSource: "api_key_env" });
    expect(report.status).toBe("unavailable");
    expect(report.reasons.join(" ")).toContain("does not support auth source api_key_env");
  });

  it("reports an unresolvable command as unavailable with every intent disabled", async () => {
    const adapter = createExternalHarnessAdapter(
      row({ command: "claudexor-missing-external-cli" }),
    );
    const report = await adapter.doctor({ cwd: process.cwd() });
    expect(report.status).toBe("unavailable");
    expect(report.enabled_intents).toEqual([]);
    expect(report.disabled_intents.length).toBeGreaterThan(0);
  });
});

describe("run", () => {
  const ECHO_ARGV =
    'process.stdout.write(JSON.stringify({type:"message",text:process.argv.slice(1).join("|")})+"\\n")';

  it("spawns the declared argv with access flags, the model flag, and the prompt", async () => {
    const adapter = createExternalHarnessAdapter(
      row({
        args: ["-e", ECHO_ARGV],
        model_args: ["MODEL-FLAG", "{model}"],
        access_args: { full: ["FULL-FLAG"] },
      }),
    );
    const events = await collect(adapter.run(spec({ access: "full", model_hint: "ext-model-1" })));
    const message = events.find((event) => event.type === "message");
    expect(message).toMatchObject({
      text: "FULL-FLAG|MODEL-FLAG|ext-model-1|PROMPT-TOKEN",
      credential_route: "vendor_native",
      credential_source: "native_session",
    });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("places the prompt at a declared {prompt} token instead of appending it", async () => {
    const adapter = createExternalHarnessAdapter(
      row({ args: ["-e", ECHO_ARGV, "PLACE={prompt}"] }),
    );
    const events = await collect(adapter.run(spec({ access: "inherit_native" })));
    const message = events.find((event) => event.type === "message");
    expect(message).toMatchObject({ text: "PLACE=PROMPT-TOKEN" });
  });

  it("parses plain stdout when the row declares stream: text", async () => {
    const adapter = createExternalHarnessAdapter(
      row({ args: ["-e", 'process.stdout.write("plain prose\\n")'], stream: "text" }),
    );
    const events = await collect(adapter.run(spec()));
    expect(events.find((event) => event.type === "message")).toMatchObject({ text: "plain prose" });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("refuses an access profile the row does not declare instead of widening it", async () => {
    const adapter = createExternalHarnessAdapter(row({ access_args: { full: ["--full-flag"] } }));
    await expect(collect(adapter.run(spec({ access: "readonly" })))).rejects.toThrow(
      AccessProfileIncompatibleError,
    );
  });
});
