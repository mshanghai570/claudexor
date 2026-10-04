import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  print: vi.fn(),
  printJson: vi.fn(),
  printUsageError: vi.fn(() => 2),
}));

vi.mock("./cli-io.js", () => ({
  print: mocks.print,
  printJson: mocks.printJson,
  printUsageError: mocks.printUsageError,
}));

// The config-writing verbs are stubbed: these tests pin the ROW the command
// builds (and the refusal paths), never the global config file on this host.
const configMocks = vi.hoisted(() => ({
  addExternalHarnessRow: vi.fn(),
  removeExternalHarnessRow: vi.fn(),
}));

vi.mock("./external-harness-presets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./external-harness-presets.js")>()),
  ...configMocks,
}));

import { FAKE_KINDS } from "@claudexor/harness-fake";
import { parseArgs } from "./args.js";
import { harnessCommand } from "./harness-command.js";

// `harness list` plus the RESTORED disclosed installer (issue #89): list
// stays exactly as it was after the PR #82 cut, and install now routes to
// harness-installer.ts (pinned versions, disclosure-before-execution — its
// own suite covers the details; here we pin the dispatch and the refusal).
describe("harnessCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only real harnesses by default — fakes stay undisclosed", () => {
    expect(harnessCommand(parseArgs(["harness", "list"]), true)).toBe(0);
    expect(mocks.printJson).toHaveBeenCalledTimes(1);
    const { harnesses } = mocks.printJson.mock.calls[0]?.[0] as { harnesses: string[] };
    for (const id of ["codex", "claude", "cursor"]) expect(harnesses).toContain(id);
    expect(harnesses.filter((id) => (FAKE_KINDS as readonly string[]).includes(id))).toEqual([]);
    expect(mocks.print).not.toHaveBeenCalled();
  });

  it("reveals the fake fixtures with --all and prints one id per line in text mode", () => {
    expect(harnessCommand(parseArgs(["harness", "list", "--all"]), false)).toBe(0);
    const printed = mocks.print.mock.calls.map((call) => call[0] as string);
    for (const id of ["codex", ...FAKE_KINDS]) expect(printed).toContain(id);
    expect(printed).toEqual([...new Set(printed)]);
    expect(mocks.printJson).not.toHaveBeenCalled();
  });

  it("rejects flags the dispatched subcommand does not own with a loud exit-2 usage error", () => {
    // INV-021: `harness list --yes` and `harness install --all` must never
    // silently ignore the stray flag; the usage line names it.
    expect(harnessCommand(parseArgs(["harness", "list", "--yes"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(false, expect.stringContaining("--yes"));
    expect(harnessCommand(parseArgs(["harness", "list", "--dry-run"]), true)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(
      true,
      expect.stringContaining("--dry-run"),
    );
    expect(harnessCommand(parseArgs(["harness", "install", "codex", "--all"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(false, expect.stringContaining("--all"));
    // Nothing was listed or installed on any of the refused paths.
    expect(mocks.print).not.toHaveBeenCalled();
    expect(mocks.printJson).not.toHaveBeenCalled();
  });

  it("still accepts each subcommand's own flags after the ownership check", () => {
    expect(harnessCommand(parseArgs(["harness", "list", "--all"]), true)).toBe(0);
    expect(mocks.printUsageError).not.toHaveBeenCalled();
    expect(harnessCommand(parseArgs(["harness", "install", "codex", "--dry-run"]), true)).toBe(0);
    expect(mocks.printUsageError).not.toHaveBeenCalled();
  });

  it("rejects unknown verbs with the usage error, naming every installable harness", () => {
    // Spelled out on purpose: the verb list is DERIVED from
    // INSTALLABLE_HARNESSES in the source, so this literal is the independent
    // oracle that catches a new installable harness missing from the usage.
    expect(harnessCommand(parseArgs(["harness", "bogus"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenCalledWith(
      false,
      "usage: claudexor harness list [--all] | install <agy|claude|codex|cursor|opencode> [--target <local|remote>] [--dry-run] [--yes] | add [preset|id] [--command <bin>] [--arg=<token>]... [--model-arg=<token>]... [--stream jsonl|text] [--key-env <VAR>] [--display-name <name>] | remove <id>",
    );
  });

  it("routes install to the disclosed installer, which refuses without confirmation", () => {
    // Non-TTY, no --yes: the pinned disclosure prints, then a loud refusal —
    // exit 1, and NEVER the usage path (the verb exists again).
    expect(harnessCommand(parseArgs(["harness", "install", "codex"]), false)).toBe(1);
    expect(mocks.printUsageError).not.toHaveBeenCalled();
    const printed = mocks.print.mock.calls.map((call) => call[0] as string).join("\n");
    expect(printed).toContain("@openai/codex@");
    expect(printed).not.toContain("@latest");
    expect(printed).toContain("Not installing");
  });

  it("lists the shippable external-harness presets when `add` is given no id", () => {
    expect(harnessCommand(parseArgs(["harness", "add"]), false)).toBe(0);
    const printed = mocks.print.mock.calls.map((call) => call[0] as string).join("\n");
    for (const id of ["gemini", "cline", "copilot", "kilo", "aider", "grok", "devin", "vibe"]) {
      expect(printed).toContain(id);
    }
    expect(mocks.printUsageError).not.toHaveBeenCalled();
    expect(configMocks.addExternalHarnessRow).not.toHaveBeenCalled();
  });

  it("writes a preset-backed config row for `add <preset>`", () => {
    expect(harnessCommand(parseArgs(["harness", "add", "gemini"]), true)).toBe(0);
    expect(configMocks.addExternalHarnessRow).toHaveBeenCalledTimes(1);
    const row = configMocks.addExternalHarnessRow.mock.calls[0]?.[0] as {
      id: string;
      command: string;
      stream: string;
      args: string[];
      auth_probe: string[] | null;
    };
    expect(row).toMatchObject({ id: "gemini", command: "gemini", stream: "jsonl" });
    expect(row.args).toContain("{prompt}");
    expect(row.auth_probe).not.toBeNull();
    expect(mocks.printJson).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, harness: "gemini", preset: "gemini" }),
    );
  });

  it("builds a custom row from --command/--arg/--stream/--key-env", () => {
    const parsed = parseArgs([
      "harness",
      "add",
      "mytool",
      "--command",
      "mybin",
      "--arg=--fast",
      "--arg",
      "{prompt}",
      "--stream",
      "text",
      "--key-env",
      "MY_TOOL_KEY",
      "--display-name",
      "My Tool",
    ]);
    expect(harnessCommand(parsed, true)).toBe(0);
    const row = configMocks.addExternalHarnessRow.mock.calls.at(-1)?.[0] as {
      id: string;
      command: string;
      display_name: string;
      args: string[];
      stream: string;
      key_env: string;
    };
    expect(row).toMatchObject({
      id: "mytool",
      command: "mybin",
      display_name: "My Tool",
      args: ["--fast", "{prompt}"],
      stream: "text",
      key_env: "MY_TOOL_KEY",
    });
  });

  it("refuses an unknown preset without --command, naming the preset list", () => {
    expect(harnessCommand(parseArgs(["harness", "add", "mytool"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(
      false,
      expect.stringContaining("--command <bin>"),
    );
    expect(configMocks.addExternalHarnessRow).not.toHaveBeenCalled();
  });

  it("refuses an invalid --stream and a stray flag the add verb does not own", () => {
    expect(
      harnessCommand(
        parseArgs(["harness", "add", "mytool", "--command", "mybin", "--stream", "yaml"]),
        false,
      ),
    ).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(
      false,
      expect.stringContaining("--stream"),
    );
    // INV-021: install-only flags stay loud on the add verb.
    expect(harnessCommand(parseArgs(["harness", "add", "gemini", "--yes"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(false, expect.stringContaining("--yes"));
    expect(configMocks.addExternalHarnessRow).not.toHaveBeenCalled();
  });

  it("removes a config row and surfaces the config error as a usage error", () => {
    expect(harnessCommand(parseArgs(["harness", "remove", "gemini"]), true)).toBe(0);
    expect(configMocks.removeExternalHarnessRow).toHaveBeenCalledWith("gemini");
    expect(mocks.printJson).toHaveBeenCalledWith({ ok: true, removed: "gemini" });

    configMocks.removeExternalHarnessRow.mockImplementationOnce(() => {
      throw new Error('no external harness "nope" configured');
    });
    expect(harnessCommand(parseArgs(["harness", "remove", "nope"]), false)).toBe(2);
    expect(mocks.printUsageError).toHaveBeenLastCalledWith(
      false,
      expect.stringContaining('no external harness "nope" configured'),
    );
  });
});
