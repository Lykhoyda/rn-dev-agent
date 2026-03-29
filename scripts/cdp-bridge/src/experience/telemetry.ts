import { appendFileSync, existsSync, readFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { redact } from './redact.js';
import { captureFingerprint } from './fingerprint.js';
import type { TelemetryEvent, ExperienceConfig, EnvironmentFingerprint } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

const AGENT_DIR = join(homedir(), '.claude', 'rn-agent');
const TELEMETRY_DIR = join(AGENT_DIR, 'telemetry');
const CONFIG_PATH = join(AGENT_DIR, 'config.json');

let config: ExperienceConfig | null = null;
let fingerprint: EnvironmentFingerprint | null = null;
let currentLogPath: string | null = null;
let enabled: boolean | null = null;

function loadConfig(): ExperienceConfig {
  if (config) return config;
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<ExperienceConfig>;
      config = { ...DEFAULT_CONFIG, ...raw };
    } else {
      config = DEFAULT_CONFIG;
    }
  } catch {
    config = DEFAULT_CONFIG;
  }
  return config;
}

function isEnabled(): boolean {
  if (enabled !== null) return enabled;
  const cfg = loadConfig();
  enabled = cfg.experience_engine && existsSync(AGENT_DIR);
  return enabled;
}

function getLogPath(): string {
  if (currentLogPath) return currentLogPath;
  const date = new Date().toISOString().split('T')[0];
  const slug = `session-${process.pid}`;
  currentLogPath = join(TELEMETRY_DIR, `${date}-${slug}.jsonl`);
  return currentLogPath;
}

function getFingerprint(): EnvironmentFingerprint {
  if (!fingerprint) fingerprint = captureFingerprint();
  return fingerprint;
}

function writeEvent(event: TelemetryEvent): void {
  if (!isEnabled()) return;
  if (!existsSync(TELEMETRY_DIR)) return;

  try {
    const redacted = redact(event as unknown as Record<string, unknown>);
    const line = JSON.stringify(redacted) + '\n';
    appendFileSync(getLogPath(), line);
  } catch {
    // best-effort — never crash the MCP server for telemetry
  }
}

export function logToolCall(
  tool: string,
  params: Record<string, unknown>,
  result: 'PASS' | 'FAIL' | 'ERROR',
  latencyMs: number,
  error?: string,
): void {
  writeEvent({
    ts: new Date().toISOString(),
    run: `pid-${process.pid}`,
    phase: 'tool',
    event: 'tool_call',
    tool,
    params,
    result,
    latency_ms: latencyMs,
    error,
    env: getFingerprint(),
  });
}

export function logFailure(
  tool: string,
  error: string,
  recovery?: string,
  recoveryResult?: 'PASS' | 'FAIL',
): void {
  writeEvent({
    ts: new Date().toISOString(),
    run: `pid-${process.pid}`,
    phase: 'tool',
    event: 'failure',
    tool,
    error,
    recovery,
    recovery_result: recoveryResult,
    env: getFingerprint(),
  });
}

export function pruneOldTelemetry(): void {
  if (!isEnabled()) return;
  if (!existsSync(TELEMETRY_DIR)) return;

  const cfg = loadConfig();
  const cutoff = Date.now() - cfg.retention_days * 24 * 60 * 60 * 1000;
  const maxBytes = cfg.max_telemetry_mb * 1024 * 1024;

  try {
    const files = readdirSync(TELEMETRY_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        try {
          const p = join(TELEMETRY_DIR, f);
          const s = statSync(p);
          return { name: f, path: p, mtime: s.mtimeMs, size: s.size };
        } catch { return null; }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => a.mtime - b.mtime);

    let totalSize = files.reduce((s, f) => s + f.size, 0);

    for (const file of files) {
      if (file.mtime < cutoff || totalSize > maxBytes) {
        unlinkSync(file.path);
        totalSize -= file.size;
      }
    }
  } catch {
    // best-effort pruning
  }
}

export type ToolHandler = (...args: unknown[]) => Promise<unknown>;

function classifyResult(result: unknown): 'PASS' | 'FAIL' {
  if (!result || typeof result !== 'object') return 'PASS';
  const envelope = result as Record<string, unknown>;
  if (envelope.isError === true) return 'FAIL';
  if (envelope.ok === false) return 'FAIL';
  const content = envelope.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first?.text && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text) as Record<string, unknown>;
        if (parsed.ok === false) return 'FAIL';
      } catch { /* not JSON */ }
    }
  }
  return 'PASS';
}

export function instrumentTool(toolName: string, handler: ToolHandler): ToolHandler {
  return async (...fnArgs: unknown[]) => {
    const start = Date.now();
    try {
      const result = await handler(...fnArgs);
      const latency = Date.now() - start;
      const status = classifyResult(result);
      const params = (fnArgs[0] && typeof fnArgs[0] === 'object') ? fnArgs[0] as Record<string, unknown> : {};
      logToolCall(toolName, params, status, latency);
      return result;
    } catch (err) {
      const latency = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      const params = (fnArgs[0] && typeof fnArgs[0] === 'object') ? fnArgs[0] as Record<string, unknown> : {};
      logToolCall(toolName, params, 'ERROR', latency, msg);
      throw err;
    }
  };
}
