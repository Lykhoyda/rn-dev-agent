export type ToolHandler = (...args: unknown[]) => Promise<unknown>;

export interface ToolObserverInput {
  tool: string;
  params: Record<string, unknown>;
  status: "PASS" | "FAIL" | "ERROR";
  latencyMs: number;
  result?: unknown;
  error?: string;
  ghost?: { attempted: boolean; outcome: string };
}

let toolObserver: ((o: ToolObserverInput) => void) | null = null;

export function setToolObserver(fn: ((o: ToolObserverInput) => void) | null): void {
  toolObserver = fn;
}

function notifyObserver(o: ToolObserverInput): void {
  if (!toolObserver) return;
  try {
    toolObserver(o);
  } catch {
    /* observability is non-load-bearing */
  }
}

function classifyResult(result: unknown): "PASS" | "FAIL" {
  if (!result || typeof result !== "object") return "PASS";
  const envelope = result as Record<string, unknown>;
  // GH#202: a BUSY_FLOW_ACTIVE refusal is expected device contention (the arbiter
  // declined to interleave a read/tap with a running flow), not a tool failure —
  // keep it out of FAIL telemetry. It rides in on a failResult envelope
  // (isError:true), so this guard must run before the isError/ok checks.
  if (resultCode(envelope) === "BUSY_FLOW_ACTIVE") return "PASS";
  if (envelope.isError === true) return "FAIL";
  if (envelope.ok === false) return "FAIL";
  const content = envelope.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first?.text && typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text) as Record<string, unknown>;
        if (parsed.ok === false) return "FAIL";
      } catch {
        /* not JSON */
      }
    }
  }
  return "PASS";
}

function resultCode(envelope: Record<string, unknown>): string | null {
  const content = envelope.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as Record<string, unknown> | undefined;
  if (!first?.text || typeof first.text !== "string") return null;
  try {
    const parsed = JSON.parse(first.text) as Record<string, unknown>;
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    /* not JSON */
  }
  return null;
}

function extractErrorFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const envelope = result as Record<string, unknown>;
  const content = envelope.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as Record<string, unknown> | undefined;
  if (!first?.text || typeof first.text !== "string") return null;
  try {
    const parsed = JSON.parse(first.text) as Record<string, unknown>;
    if (parsed.ok === false && typeof parsed.error === "string") return parsed.error;
  } catch {
    /* not JSON */
  }
  if (envelope.isError === true) return first.text;
  return null;
}

export function instrumentTool(toolName: string, handler: ToolHandler): ToolHandler {
  return async (...fnArgs: unknown[]) => {
    const start = Date.now();
    const params =
      fnArgs[0] && typeof fnArgs[0] === "object" ? (fnArgs[0] as Record<string, unknown>) : {};
    try {
      const result = await handler(...fnArgs);
      const latency = Date.now() - start;
      const status = classifyResult(result);
      notifyObserver({
        tool: toolName,
        params,
        status,
        latencyMs: latency,
        result,
        error: status === "FAIL" ? (extractErrorFromResult(result) ?? undefined) : undefined,
      });
      return result;
    } catch (err) {
      const latency = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      notifyObserver({ tool: toolName, params, status: "ERROR", latencyMs: latency, error: msg });
      throw err;
    }
  };
}
