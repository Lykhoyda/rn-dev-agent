#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CDPClient } from "./cdp-client.js";

let client = new CDPClient();

const server = new McpServer({
  name: "rn-dev-agent-cdp",
  version: "0.1.0",
});

const ensureConnected = async (): Promise<void> => {
  if (!client.connected) {
    await client.autoConnect();
  }
};

// ─── CONNECTION ──────────────────────────────────────

server.tool(
  "cdp_status",
  "Get full environment status. Auto-connects if not connected. Returns Metro status, CDP connection, app info, capabilities, active errors, and RedBox/paused state. Call this FIRST before any testing.",
  { metroPort: z.number().optional().describe("Override Metro port (default: auto-detect)") },
  async ({ metroPort }) => {
    try {
      if (metroPort && metroPort !== client.currentPort) {
        client.disconnect();
        client = new CDPClient(metroPort);
      }
      await ensureConnected();

      const appInfo = await client.evaluate("__RN_AGENT.getAppInfo()");
      const errorCount = await client.evaluate("__RN_AGENT.getErrors().length") as number;
      const hasRedBox = await client.evaluate(
        '__RN_AGENT.getTree(1)?.includes?.("APP_HAS_REDBOX") || false'
      );
      const isReady = await client.evaluate("__RN_AGENT.isReady()");

      let parsedApp: Record<string, unknown> = {};
      try {
        parsedApp = typeof appInfo === "string" ? JSON.parse(appInfo) : (appInfo as Record<string, unknown>) ?? {};
      } catch {
        parsedApp = {};
      }

      const status = {
        metro: { running: true, port: client.currentPort },
        cdp: { connected: client.connected, device: client.deviceName, pageId: client.pageId },
        app: {
          ...parsedApp,
          hasRedBox: hasRedBox === true,
          isPaused: client.isPaused,
          errorCount: typeof errorCount === "number" ? errorCount : 0,
        },
        capabilities: {
          networkDomain: client.networkMode === "cdp",
          fiberTree: isReady === true,
          networkFallback: client.networkMode === "hook",
        },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Connection failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── INSPECTION ──────────────────────────────────────

server.tool(
  "cdp_component_tree",
  "Get React component tree with props, state, testIDs. Use filter to scope — NEVER request full tree (saves tokens). Detects RedBox.",
  {
    filter: z.string().optional().describe("Component name or testID to scope query (e.g. 'CartBadge', 'product-list')"),
    depth: z.number().default(3).describe("Max depth (default 3, max 6)"),
  },
  async ({ filter, depth }) => {
    await ensureConnected();
    const clampedDepth = Math.min(depth, 6);
    const filterArg = filter ? `"${filter.replace(/"/g, '\\"')}"` : "undefined";
    const result = await client.evaluate(`__RN_AGENT.getTree(${clampedDepth}, ${filterArg})`);

    if (typeof result === "string") {
      return { content: [{ type: "text" as const, text: result }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "cdp_navigation_state",
  "Get current navigation state: active route, params, stack history, nested navigators, active tab. Works with React Navigation and Expo Router.",
  {},
  async () => {
    await ensureConnected();
    const result = await client.evaluate("__RN_AGENT.getNavState()");
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "cdp_store_state",
  "Read app store state (Redux, Zustand). Use path to query specific slice (e.g. 'cart.items'). For Zustand: app must expose stores via global.__ZUSTAND_STORES__.",
  {
    path: z.string().optional().describe("Dot-path into store state (e.g. 'cart.items', 'auth.user.name')"),
  },
  async ({ path }) => {
    await ensureConnected();
    const pathArg = path ? `"${path.replace(/"/g, '\\"')}"` : "undefined";
    const result = await client.evaluate(`__RN_AGENT.getStoreState(${pathArg})`);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "cdp_network_log",
  "Get recent network requests. Shows method, URL, status, duration. On RN 0.83+ uses CDP Network domain; older versions use injected fetch/XHR hooks.",
  {
    limit: z.number().default(20).describe("Max entries to return"),
    filter: z.string().optional().describe("Filter by URL substring"),
  },
  async ({ limit, filter }) => {
    await ensureConnected();

    let entries;
    if (client.networkMode === "cdp") {
      entries = client.networkBuffer.getAll();
    } else {
      const raw = await client.evaluate(
        `JSON.stringify(globalThis.__RN_AGENT_NETWORK_LOG__ || [])`
      );
      try {
        entries = typeof raw === "string" ? JSON.parse(raw) : [];
      } catch {
        entries = [];
      }
    }

    if (filter) {
      entries = entries.filter((e: { url?: string }) => e.url?.includes(filter));
    }

    entries = entries.slice(-limit);
    return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
  }
);

server.tool(
  "cdp_console_log",
  "Get recent console output. Buffered in ring buffer so logs between agent calls are preserved.",
  {
    level: z.enum(["all", "log", "warn", "error"]).default("all").describe("Filter by log level"),
    limit: z.number().default(50).describe("Max entries to return"),
  },
  async ({ level, limit }) => {
    await ensureConnected();
    let entries = client.consoleBuffer.getAll();

    if (level !== "all") {
      entries = entries.filter((e) => e.level === level);
    }

    entries = entries.slice(-limit);
    return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
  }
);

server.tool(
  "cdp_error_log",
  "Get unhandled JS errors and promise rejections. If empty but app crashed, the error is NATIVE — use bash logcat/simctl log. Set clear=true to reset the error buffer after reading.",
  {
    clear: z.boolean().default(false).describe("Clear the error buffer after reading"),
  },
  async ({ clear }) => {
    await ensureConnected();
    const result = await client.evaluate("__RN_AGENT.getErrors()");
    if (clear) {
      await client.evaluate("__RN_AGENT.clearErrors()");
    }
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── EXECUTION ───────────────────────────────────────

server.tool(
  "cdp_evaluate",
  "Execute arbitrary JavaScript in Hermes runtime. Has 5-second timeout. Use for one-off checks not covered by other tools.",
  {
    expression: z.string().describe("JavaScript expression to evaluate"),
    awaitPromise: z.boolean().default(false).describe("Whether to await the result if it's a Promise"),
  },
  async ({ expression, awaitPromise }) => {
    await ensureConnected();
    const result = await client.evaluate(expression, awaitPromise);

    if (typeof result === "object" && result !== null && "error" in result) {
      return {
        content: [{ type: "text" as const, text: `Evaluation error: ${JSON.stringify(result)}` }],
        isError: true,
      };
    }

    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text: text ?? "undefined" }] };
  }
);

server.tool(
  "cdp_reload",
  "Trigger hot reload (Fast Refresh) or full reload. After full reload, auto-reconnects to new Hermes target.",
  {
    full: z.boolean().default(false).describe("Full reload (true) or Fast Refresh (false)"),
  },
  async ({ full }) => {
    await ensureConnected();
    const result = await client.reload(full);
    return { content: [{ type: "text" as const, text: result }] };
  }
);

server.tool(
  "cdp_dev_settings",
  "Control React Native dev settings programmatically (no visual dev menu needed).",
  {
    action: z.enum(["reload", "toggleInspector", "togglePerfMonitor", "dismissRedBox"]).describe("Action to perform"),
  },
  async ({ action }) => {
    await ensureConnected();

    const actions: Record<string, string> = {
      reload: 'require("react-native/Libraries/Utilities/DevSettings").reload()',
      toggleInspector: 'require("react-native/Libraries/Utilities/DevSettings").setIsShakeToShowDevMenuEnabled && require("react-native/Libraries/Inspector/Inspector")',
      togglePerfMonitor: 'require("react-native/Libraries/Performance/RCTRenderingPerf")',
      dismissRedBox: 'require("react-native/Libraries/LogBox/LogBox").ignoreLogs([""])',
    };

    const expr = actions[action];
    if (!expr) {
      return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
    }

    const result = await client.evaluate(expr);
    return { content: [{ type: "text" as const, text: `${action} executed. Result: ${JSON.stringify(result)}` }] };
  }
);

// ─── START SERVER ────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("rn-dev-agent-cdp MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
