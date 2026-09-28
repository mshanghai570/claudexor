import { describe, expect, it, vi } from "vitest";

// userMcpServersFor warns on collisions; keep the test output clean.
vi.spyOn(console, "error").mockImplementation(() => {});

import type { GlobalConfig, PaidBudget } from "@claudexor/schema";
import { extraMcpServersFor, userMcpServersFor } from "./delegationBelt.js";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";

function configWith(servers: Array<Record<string, unknown>>): GlobalConfig {
  return { mcp: { servers } } as unknown as GlobalConfig;
}

const server = (name: string) => ({
  name,
  command: `/usr/bin/${name}`,
  args: [],
  env: {},
  required: false,
});

const routed = { delegationRequirement: { effective: false } } as unknown as RoutedAdapter;
const budget = { kind: "unlimited" } as unknown as PaidBudget;

describe("userMcpServersFor", () => {
  it("passes config servers through as ExtraMcpServer rows", () => {
    const out = userMcpServersFor(configWith([server("docs")]));
    expect(out).toEqual([server("docs")]);
  });

  it("drops the reserved belt name and duplicates with a warning", () => {
    const out = userMcpServersFor(
      configWith([server("claudexor"), server("docs"), server("docs")]),
    );
    expect(out.map((s) => s.name)).toEqual(["docs"]);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("returns [] with no config", () => {
    expect(userMcpServersFor(undefined)).toEqual([]);
  });
});

describe("extraMcpServersFor", () => {
  it("merges belt and user servers, never shadowing the belt name", () => {
    const input = {
      delegate: true,
      delegationParentRunId: "run-parent",
      delegationBelt: server("claudexor"),
    } as unknown as RunInput;
    const routedWithBelt = {
      delegationRequirement: { effective: true },
    } as unknown as RoutedAdapter;
    const out = extraMcpServersFor(
      input,
      "implement",
      routedWithBelt,
      budget,
      configWith([server("docs"), server("claudexor")]),
    );
    expect(out.map((s) => s.name)).toEqual(["claudexor", "docs"]);
  });

  it("user servers ride lanes without the belt", () => {
    const out = extraMcpServersFor(
      undefined,
      "review",
      routed,
      budget,
      configWith([server("docs")]),
    );
    expect(out.map((s) => s.name)).toEqual(["docs"]);
  });
});
