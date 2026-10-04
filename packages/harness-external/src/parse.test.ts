import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { externalTextEvent, parseExternalEvent } from "./parse.js";

const SID = "ext-session";

function parse(obj: unknown) {
  const events = parseExternalEvent(obj, SID);
  if (Array.isArray(events)) {
    for (const event of events) expect(HarnessEvent.safeParse(event).success).toBe(true);
  }
  return events;
}

describe("parseExternalEvent (jsonl)", () => {
  it("maps a flat text frame to a message event", () => {
    expect(parse({ type: "message", text: "hello" })).toEqual([
      { type: "message", session_id: SID, ts: expect.any(String), text: "hello" },
    ]);
    // Several CLIs spell the same frame differently; both are messages.
    expect(parse({ type: "assistant", value: "hi" })?.[0]).toMatchObject({ text: "hi" });
  });

  it("reads Gemini-style content.parts arrays", () => {
    const events = parse({ type: "message", role: "model", content: [{ text: "part one" }] });
    expect(events).toEqual([
      { type: "message", session_id: SID, ts: expect.any(String), text: "part one" },
    ]);
  });

  it("surfaces a native session id on the started event", () => {
    expect(parse({ type: "session", sessionID: "ses_42", model: "m1" })).toEqual([
      {
        type: "started",
        session_id: SID,
        ts: expect.any(String),
        observed_model: "m1",
        payload: { native_session_id: "ses_42" },
      },
    ]);
  });

  it("emits tool_call / tool_result pairs and a file_change for edit tools", () => {
    expect(parse({ type: "tool_call", id: "c1", tool: "bash", status: "running" })).toEqual([
      {
        type: "tool_call",
        session_id: SID,
        ts: expect.any(String),
        text: "bash",
        tool: {
          name: "bash",
          kind: "command",
          use_id: "c1",
          target: undefined,
        },
      },
    ]);

    const done = parse({
      type: "tool_result",
      id: "c2",
      tool: "edit_file",
      status: "completed",
      path: "src/a.ts",
      output: "ok",
    });
    expect(done?.[0]).toMatchObject({ type: "tool_result", tool: { status: "ok" } });
    expect(done?.[1]).toMatchObject({
      type: "file_change",
      payload: { path: "src/a.ts", tool: "edit_file" },
    });
  });

  it("keeps a failed tool result typed as an error summary", () => {
    const events = parse({ type: "tool_result", tool: "bash", status: "error", error: "boom" });
    expect(events?.[0]).toMatchObject({
      type: "tool_result",
      text: "tool_result: error: boom",
      tool: { status: "error", error_summary: "boom" },
    });
  });

  it("maps explicit error frames and usage frames", () => {
    expect(parse({ type: "error", message: "vendor said no" })).toEqual([
      { type: "error", session_id: SID, ts: expect.any(String), error: "vendor said no" },
    ]);
    expect(parse({ type: "usage", usage: { input: 10, output: 3 } })).toEqual([
      {
        type: "usage",
        session_id: SID,
        ts: expect.any(String),
        usage: { input_tokens: 10, output_tokens: 3 },
      },
    ]);
  });

  it("recognizes-but-skips namespaced status chatter instead of counting drops", () => {
    expect(parse({ type: "session.warning", message: "meh" })).toEqual([]);
    expect(parse({ type: "done" })).toEqual([]);
  });

  it("returns null for frames it cannot recognize (the run loop counts those)", () => {
    expect(parse({ type: "mystery-frame", whatever: 1 })).toBeNull();
    expect(parse("not-an-object")).toBeNull();
  });
});

describe("externalTextEvent (stream: text)", () => {
  it("emits one message per non-empty line and skips blanks", () => {
    expect(externalTextEvent("plain output", SID)).toEqual([
      { type: "message", session_id: SID, ts: expect.any(String), text: "plain output" },
    ]);
    expect(externalTextEvent("   ", SID)).toEqual([]);
  });
});
