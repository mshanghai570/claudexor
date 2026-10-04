import type { HarnessEvent, ToolKind, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

type Json = any;

/**
 * Generic ND-JSON translation for config-declared external CLIs (Cline, Gemini
 * CLI, Kilo, Copilot, Aider, ...). Unlike a vendor adapter this cannot assume
 * one recorded wire shape, so it recognizes the shapes those CLIs actually
 * emit (flat `text`, `content.parts[]`, nested `message.content[]`, tool
 * call/result pairs, usage frames) and returns `null` for anything it does not
 * recognize — the shared run loop COUNTS those drops and reports them on the
 * terminal event instead of silently degrading to an empty stream.
 */
export function parseExternalEvent(obj: Json, sessionId: string): HarnessEvent[] | null {
  const ts = nowIso();
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rawType = obj.type ?? obj.event ?? obj.kind ?? "";
  const type = typeof rawType === "string" ? rawType : String(rawType ?? "");
  const lower = type.toLowerCase();

  // Terminal/fatal frames: an explicit error event, or any frame carrying one.
  if (lower === "error" || lower.endsWith(".error") || lower.includes("error")) {
    const detail = errorDetail(obj);
    return [
      {
        type: "error",
        session_id: sessionId,
        ts,
        error: detail || `${type || "external CLI"} error`,
      },
    ];
  }

  // Copilot-style namespaced status chatter (`session.warning`,
  // `session.mcp_server_status_changed`, ...): recognized, intentionally skipped.
  if (lower.startsWith("session.") || lower.startsWith("step.") || lower === "ping") return [];

  // Session start: surface a native session id when the CLI discloses one.
  if (lower === "session" || lower === "start" || lower === "init" || lower === "started") {
    const nativeId = stringOrUndef(
      obj.sessionID ?? obj.sessionId ?? obj.session_id ?? obj.session?.id ?? obj.conversationId,
    );
    return [
      {
        type: "started",
        session_id: sessionId,
        ts,
        observed_model: stringOrUndef(obj.model ?? obj.modelId),
        ...(nativeId ? { payload: { native_session_id: nativeId } } : {}),
      },
    ];
  }

  // Usage/token accounting frames.
  if (lower.includes("usage") || lower.includes("token") || typeof obj.cost === "number") {
    const usage = usageOf(obj);
    return usage === null ? [] : [{ type: "usage", session_id: sessionId, ts, usage }];
  }

  // Tool lifecycle: any frame naming a tool (call/result variants across CLIs).
  const toolName = toolNameOf(obj, lower);
  if (toolName !== null) return toolEvents(obj, toolName, sessionId, ts, lower);

  const text = textOf(obj);
  if (text !== null) {
    // Terminal frames that restate the final answer are still messages.
    if (lower === "result" || lower.endsWith(".result") || lower.includes("final")) {
      return [{ type: "message", session_id: sessionId, ts, text }];
    }
    if (lower === "thinking" || lower.includes("reasoning")) {
      return [{ type: "message", session_id: sessionId, ts, text }];
    }
    return [{ type: "message", session_id: sessionId, ts, text }];
  }

  // A recognized terminal frame with no payload: skipped, not dropped.
  if (
    lower === "result" ||
    lower === "done" ||
    lower === "complete" ||
    lower.endsWith(".complete") ||
    lower === "finish" ||
    lower === "end"
  ) {
    return [];
  }

  return null;
}

/**
 * `stream: "text"` translation: each non-empty stdout line is one message
 * event (blank lines are recognized and skipped, never counted as drops).
 */
export function externalTextEvent(line: string, sessionId: string): HarnessEvent[] | null {
  const text = line.trim();
  if (!text) return [];
  return [{ type: "message", session_id: sessionId, ts: nowIso(), text: redactSecrets(text) }];
}

function toolNameOf(obj: Json, lower: string): string | null {
  const candidate = obj.tool ?? obj.toolName ?? obj.tool_name ?? obj.name ?? obj.tool?.name;
  if (typeof candidate === "string" && candidate) return candidate;
  const explicit = obj.part?.tool ?? obj.part?.name;
  if (typeof explicit === "string" && explicit) return explicit;
  if (lower.includes("tool") || lower.includes("command")) {
    const fallback = obj.action ?? obj.command;
    if (typeof fallback === "string" && fallback) return fallback;
    return typeLabel(lower);
  }
  return null;
}

function typeLabel(lower: string): string | null {
  if (lower.includes("tool_call") || lower.includes("toolcall")) return "tool_call";
  if (lower.includes("tool_result") || lower.includes("toolresult")) return "tool_result";
  if (lower.includes("command")) return "command";
  return null;
}

function toolEvents(
  obj: Json,
  name: string,
  sessionId: string,
  ts: string,
  lower: string,
): HarnessEvent[] {
  const status = String(obj.status ?? obj.state ?? obj.part?.state?.status ?? "").toLowerCase();
  const failed =
    status === "error" || status === "failed" || status === "failure" || lower.includes("error");
  const done =
    status === "completed" ||
    status === "complete" ||
    status === "done" ||
    status === "success" ||
    status === "ok" ||
    lower.includes("tool_result") ||
    lower.includes("result");
  const target = boundedTarget(
    obj.path ?? obj.args?.path ?? obj.file_path ?? obj.filePath ?? obj.args?.command ?? obj.command,
  );
  const useId = stringOrUndef(obj.id ?? obj.call_id ?? obj.callId ?? obj.tool_call_id);
  const tool: ToolRef = { name, kind: toolKindFor(name), use_id: useId, target };

  if (failed) {
    const detail = summarize(obj.error ?? obj.message ?? obj.output);
    return [
      {
        type: "tool_result",
        session_id: sessionId,
        ts,
        text: `tool_result: error${detail ? `: ${detail}` : ""}`,
        tool: { ...tool, status: "error", error_summary: detail || "tool call failed" },
      },
    ];
  }
  if (done) {
    const detail = summarize(obj.output ?? obj.result ?? obj.content ?? obj.error);
    const events: HarnessEvent[] = [
      {
        type: "tool_result",
        session_id: sessionId,
        ts,
        text: "tool_result",
        tool: { ...tool, status: "ok", ...(detail ? { content_summary: detail } : {}) },
      },
    ];
    if (EDIT_TOOLS.test(name)) {
      events.push({
        type: "file_change",
        session_id: sessionId,
        ts,
        tool: { name, kind: "file", use_id: useId },
        payload: { path: target, tool: name },
      });
    }
    return events;
  }
  return [{ type: "tool_call", session_id: sessionId, ts, text: name, tool }];
}

const EDIT_TOOLS = /edit|write|patch|apply|insert/i;

function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("webfetch") || n.includes("websearch") || n === "fetch" || n.includes("browse"))
    return "web";
  if (n.includes("bash") || n.includes("shell") || n.includes("command") || n.includes("exec"))
    return "command";
  if (n.includes("glob") || n.includes("grep") || n.includes("search")) return "search";
  if (
    n.includes("edit") ||
    n.includes("write") ||
    n.includes("patch") ||
    n.includes("read") ||
    n.includes("file") ||
    n === "ls"
  )
    return "file";
  if (n.includes("mcp")) return "mcp";
  return "other";
}

/** Best-effort text extraction across the shapes external CLIs emit. */
function textOf(obj: Json): string | null {
  for (const key of ["text", "value", "delta", "chunk", "content", "message", "output", "str"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  const parts = collectParts(
    obj.content ?? obj.parts ?? obj.message?.content ?? obj.message?.parts,
  );
  if (parts.length > 0) return parts.join("");
  const nested = obj.message ?? obj.data ?? obj.delta;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const key of ["text", "value", "content"]) {
      const v = nested[key];
      if (typeof v === "string" && v.trim()) return v;
    }
    const inner = collectParts(nested.content ?? nested.parts);
    if (inner.length > 0) return inner.join("");
  }
  return null;
}

function collectParts(value: Json): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      if (part) out.push(part);
      continue;
    }
    if (part && typeof part === "object" && typeof part.text === "string" && part.text) {
      out.push(part.text);
    }
  }
  return out;
}

function usageOf(obj: Json): NonNullable<HarnessEvent["usage"]> | null {
  const usage: NonNullable<HarnessEvent["usage"]> = {};
  const source = obj.usage ?? obj.tokens ?? obj.stats ?? {};
  const input = firstNumber(obj.input_tokens, source.input, source.input_tokens, source.prompt);
  const output = firstNumber(
    obj.output_tokens,
    source.output,
    source.output_tokens,
    source.completion,
  );
  const cache = firstNumber(
    obj.cached_tokens,
    source.cache,
    source.cached_input_tokens,
    source.cache_read_input_tokens,
  );
  const cost = firstNumber(obj.cost, obj.cost_usd, source.cost);
  if (typeof obj.cost === "number" || cost !== undefined) usage.cost_usd = cost;
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cache !== undefined) usage.cached_input_tokens = cache;
  return Object.keys(usage).length > 0 ? usage : null;
}

function errorDetail(obj: Json): string {
  const raw = obj.error ?? obj.message ?? obj.detail ?? obj.reason;
  if (typeof raw === "string") return redactSecrets(raw).slice(0, 1000);
  if (raw && typeof raw === "object") {
    const text = typeof raw.message === "string" ? raw.message : JSON.stringify(raw);
    return redactSecrets(text).slice(0, 1000);
  }
  return "";
}

function summarize(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return redactSecrets(value).trim().replace(/\s+/g, " ").slice(0, 1000);
}

function boundedTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactSecrets(value).slice(0, 500);
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === "number") return v;
  return undefined;
}
