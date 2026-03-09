import WebSocket from "ws";
import { RingBuffer } from "./ring-buffer.js";
import type { NetworkEntry, ConsoleEntry, CDPTarget, CDPResponse } from "./types.js";
import { INJECTED_HELPERS, NETWORK_HOOK_SCRIPT } from "./injected-helpers.js";

const DISCOVERY_PORTS = [8081, 8082, 19000, 19006];
const CDP_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 1500;
const MAX_CONNECT_RETRIES = 5;
const RETRY_DELAY_MS = 2000;
const REACT_READY_TIMEOUT_MS = 8000;

type EventHandler = (params: Record<string, unknown>) => void;

export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventHandlers = new Map<string, EventHandler[]>();
  readonly networkBuffer: RingBuffer<NetworkEntry>;
  readonly consoleBuffer: RingBuffer<ConsoleEntry>;
  private port: number;
  private reconnecting = false;
  isPaused = false;
  hasRedBox = false;
  helpersInjected = false;
  networkMode: "cdp" | "hook" | "none" = "none";
  private targetTitle = "";
  private targetId = "";

  constructor(port?: number) {
    this.port = port || 8081;
    this.networkBuffer = new RingBuffer(100);
    this.consoleBuffer = new RingBuffer(200);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentPort(): number {
    return this.port;
  }

  get deviceName(): string {
    return this.targetTitle;
  }

  get pageId(): string {
    return this.targetId;
  }

  async autoConnect(): Promise<string> {
    const metroPort = await this.findMetro();
    this.port = metroPort;

    const targets = await this.discoverTargets(metroPort);
    const target = this.pickBestTarget(targets);

    await this.connectToTarget(target);
    return `Connected to ${target.title} on port ${metroPort}`;
  }

  private async findMetro(): Promise<number> {
    const ports = [...new Set([this.port, ...DISCOVERY_PORTS])];

    for (const p of ports) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const resp = await fetch(`http://127.0.0.1:${p}/status`, { signal: ctrl.signal });
        clearTimeout(timer);
        const text = await resp.text();
        if (text.includes("packager-status:running")) return p;
      } catch {
        // Port not available
      }
    }

    throw new Error(
      "Metro not found on ports " + ports.join(", ") + ". Is the dev server running? Try: npx expo start or npx react-native start"
    );
  }

  private async discoverTargets(port: number): Promise<CDPTarget[]> {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = (await resp.json()) as CDPTarget[];

    const valid = targets
      .filter((t) => t.vm === "Hermes" && !t.title?.includes("Experimental"))
      .map((t) => ({
        ...t,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl
          ?.replace(/\[::1\]/g, "127.0.0.1")
          ?.replace(/\[::\]/g, "127.0.0.1"),
      }));

    if (valid.length === 0) {
      throw new Error("No Hermes debug target found. Is the app running? Is Hermes enabled?");
    }

    return valid;
  }

  private pickBestTarget(targets: CDPTarget[]): CDPTarget {
    return targets.reduce((a, b) => {
      const aPage = parseInt(a.id?.split("-")[1] || "0", 10);
      const bPage = parseInt(b.id?.split("-")[1] || "0", 10);
      return bPage > aPage ? b : a;
    });
  }

  private async connectToTarget(target: CDPTarget): Promise<void> {
    for (let i = 0; i < MAX_CONNECT_RETRIES; i++) {
      try {
        await this.openWebSocket(target.webSocketDebuggerUrl);
        this.targetTitle = target.title;
        this.targetId = target.id;
        await this.setup();
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("1006") || msg.includes("refused")) {
          throw new Error(
            "CDP connection rejected (code 1006). Another debugger may be connected. " +
            "Close React Native DevTools, Flipper, or Chrome DevTools and try again."
          );
        }
        if (i < MAX_CONNECT_RETRIES - 1) await sleep(RETRY_DELAY_MS);
      }
    }
    throw new Error(`Failed to connect after ${MAX_CONNECT_RETRIES} attempts`);
  }

  private openWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connection timeout"));
      }, CDP_TIMEOUT_MS);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.setupMessageHandler();
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupMessageHandler(): void {
    this.ws?.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as CDPResponse;

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }

      if (msg.method) {
        const handlers = this.eventHandlers.get(msg.method);
        if (handlers) {
          for (const handler of handlers) {
            handler(msg.params ?? {});
          }
        }
      }
    });
  }

  private onEvent(method: string, handler: EventHandler): void {
    const existing = this.eventHandlers.get(method) ?? [];
    existing.push(handler);
    this.eventHandlers.set(method, existing);
  }

  private async setup(): Promise<void> {
    await this.send("Runtime.enable");
    await this.send("Debugger.enable");

    try {
      await this.send("Network.enable");
      this.networkMode = "cdp";
    } catch {
      this.networkMode = "none";
    }

    this.setupEventHandlers();
    await this.waitForReact();
    await this.injectHelpers();

    if (this.networkMode === "none") {
      await this.injectNetworkHooks();
      this.networkMode = "hook";
    }

    this.setupReconnect();
    this.helpersInjected = true;
  }

  private setupEventHandlers(): void {
    this.onEvent("Runtime.consoleAPICalled", (params) => {
      const args = params.args as Array<{ value?: unknown; description?: string }> | undefined;
      this.consoleBuffer.push({
        level: params.type as string,
        text: args?.map((a) => a.value ?? a.description ?? "").join(" ") ?? "",
        timestamp: new Date().toISOString(),
      });
    });

    this.onEvent("Network.requestWillBeSent", (params) => {
      const request = params.request as { method?: string; url?: string } | undefined;
      this.networkBuffer.push({
        id: params.requestId as string,
        method: request?.method ?? "GET",
        url: request?.url ?? "",
        timestamp: new Date().toISOString(),
      });
    });

    this.onEvent("Network.responseReceived", (params) => {
      const entry = this.networkBuffer.findLast((e) => e.id === (params.requestId as string));
      if (entry) {
        const response = params.response as { status?: number } | undefined;
        entry.status = response?.status;
        entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
      }
    });

    this.onEvent("Debugger.paused", async () => {
      this.isPaused = true;
      try {
        await this.send("Debugger.resume");
      } catch {
        // Ignore resume errors
      }
      this.isPaused = false;
    });
  }

  private async waitForReact(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < REACT_READY_TIMEOUT_MS) {
      try {
        const result = await this.evaluate(
          'typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && __REACT_DEVTOOLS_GLOBAL_HOOK__.renderers?.size > 0'
        );
        if (result === true) return;
      } catch {
        // Not ready yet
      }
      await sleep(500);
    }
  }

  private async injectHelpers(): Promise<void> {
    await this.evaluate(INJECTED_HELPERS);
  }

  private async injectNetworkHooks(): Promise<void> {
    await this.evaluate(NETWORK_HOOK_SCRIPT);
  }

  private rejectAllPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WebSocket closed"));
    }
    this.pending.clear();
  }

  private setupReconnect(): void {
    this.ws?.on("close", async (code) => {
      this.rejectAllPending();

      if (this.reconnecting) return;
      this.reconnecting = true;
      this.helpersInjected = false;

      console.error("CDP: connection closed (reload). Reconnecting...");
      await sleep(RECONNECT_DELAY_MS);

      for (let i = 0; i < 10; i++) {
        try {
          await this.autoConnect();
          console.error("CDP: reconnected successfully");
          this.reconnecting = false;
          return;
        } catch {
          await sleep(1000);
        }
      }
      this.reconnecting = false;
    });
  }

  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const result = (await this.sendWithTimeout("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    } | undefined;

    if (result?.exceptionDetails) {
      return {
        error: result.exceptionDetails.text || result.exceptionDetails.exception?.description || "Unknown error",
      };
    }
    return result?.result?.value;
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("CDP not connected"));
        return;
      }

      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${CDP_TIMEOUT_MS}ms): ${method}`));
      }, CDP_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private sendWithTimeout(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params);
  }

  async reload(full = false): Promise<string> {
    if (full) {
      try {
        await this.evaluate('require("react-native/Libraries/Utilities/DevSettings").reload()');
      } catch {
        // Expected: WS closes during reload
      }
      await sleep(2000);
      try {
        await this.autoConnect();
        return "Full reload complete, reconnected";
      } catch (err) {
        return `Full reload triggered but reconnect failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      await this.send("Runtime.evaluate", {
        expression: 'require("react-native/Libraries/Utilities/DevSettings").reload()',
        returnByValue: true,
      });
    } catch {
      // Expected: WS may close during hot reload
    }
    return "Hot reload triggered";
  }

  disconnect(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Disconnected"));
    }
    this.pending.clear();
    this.eventHandlers.clear();
    this.ws?.close();
    this.ws = null;
    this.helpersInjected = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
