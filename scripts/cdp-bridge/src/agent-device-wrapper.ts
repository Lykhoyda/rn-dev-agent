import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import type { ToolResult } from './utils.js';
import type { SessionState } from './types.js';
import { okResult, failResult } from './utils.js';

const execFile = promisify(execFileCb);
const SESSION_FILE = '/tmp/rn-dev-agent-session.json';
const EXEC_TIMEOUT = 30_000;

let activeSession: SessionState | null = null;

try {
  const raw = readFileSync(SESSION_FILE, 'utf8');
  activeSession = JSON.parse(raw) as SessionState;
} catch {
  // No persisted session or invalid JSON — start fresh
}

export function getActiveSession(): SessionState | null {
  return activeSession;
}

export function setActiveSession(info: SessionState): void {
  activeSession = info;
  try { writeFileSync(SESSION_FILE, JSON.stringify(info), 'utf8'); } catch { /* ignore */ }
}

export function clearActiveSession(): void {
  activeSession = null;
  try { unlinkSync(SESSION_FILE); } catch { /* ignore */ }
}

export function hasActiveSession(): boolean {
  return activeSession !== null;
}

interface AgentDeviceJsonSuccess {
  success: true;
  data: unknown;
}

interface AgentDeviceJsonError {
  success: false;
  error: { code: string; message: string; hint?: string };
}

type AgentDeviceJson = AgentDeviceJsonSuccess | AgentDeviceJsonError;

export async function runAgentDevice(
  cliArgs: string[],
  opts: { skipSession?: boolean } = {},
): Promise<ToolResult> {
  const args = [...cliArgs, '--json'];
  if (!opts.skipSession && activeSession) {
    args.push('--session', activeSession.name);
  }

  try {
    const { stdout } = await execFile('agent-device', args, {
      timeout: EXEC_TIMEOUT,
      encoding: 'utf8',
    });

    let parsed: AgentDeviceJson;
    try {
      parsed = JSON.parse(stdout) as AgentDeviceJson;
    } catch {
      return failResult(`agent-device returned non-JSON: ${stdout.slice(0, 300)}`);
    }

    if (!parsed.success) {
      const e = parsed.error;
      return failResult(
        e.message,
        { code: e.code, ...(e.hint ? { hint: e.hint } : {}) },
      );
    }

    return okResult(parsed.data ?? {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('ENOENT') || msg.includes('not found')) {
      return failResult(
        'agent-device CLI not found. Install with: npm install -g agent-device',
      );
    }

    // Detect timeout (SIGTERM from execFile timeout)
    if (typeof err === 'object' && err !== null && 'killed' in err && (err as { killed?: boolean }).killed) {
      return failResult(`agent-device timed out after ${EXEC_TIMEOUT / 1000}s`);
    }

    // Try to parse JSON from stdout on non-zero exit
    if (typeof err === 'object' && err !== null && 'stdout' in err) {
      const stdout = (err as { stdout: string }).stdout;
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout) as AgentDeviceJson;
          if (parsed.success) {
            return okResult(parsed.data ?? {});
          }
          const e = parsed.error;
          return failResult(
            e.message,
            { code: e.code, ...(e.hint ? { hint: e.hint } : {}) },
          );
        } catch {
          // Not JSON — fall through
        }
      }
    }

    return failResult(`agent-device error: ${msg}`);
  }
}
