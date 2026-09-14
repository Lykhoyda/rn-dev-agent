import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Cursor injects WORKSPACE_FOLDER_PATHS on stdio MCP (JSON array, or
 * platform-delimited paths). Not interpolated from `$WORKSPACE_FOLDER_PATHS`
 * in args — read the env value.
 */
export function firstWorkspaceFolder(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let parts: string[];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return undefined;
      parts = parsed.filter((entry): entry is string => typeof entry === 'string');
    } catch {
      return undefined;
    }
  } else if (platform === 'win32') {
    parts = trimmed.split(';');
  } else {
    parts = trimmed.split(':');
  }
  return parts.map((part) => part.trim()).find((part) => part.length > 0);
}

export function isCursorHost(env: NodeJS.Dict<string | undefined> = process.env): boolean {
  const pluginRoot = env.CURSOR_PLUGIN_ROOT?.trim();
  if (pluginRoot) return true;
  return Boolean(firstWorkspaceFolder(env.WORKSPACE_FOLDER_PATHS));
}

export function isHomeProjectRoot(root: string, home: string = homedir()): boolean {
  return resolve(root) === resolve(home);
}

/**
 * Seed CLAUDE_USER_CWD from the first workspace folder when Claude did not set it.
 * Does not chdir — Codex/Cursor launchers must keep the host's process cwd.
 */
export function seedHostProjectRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const existing = env.CLAUDE_USER_CWD?.trim();
  if (existing) return existing;
  const folder = firstWorkspaceFolder(env.WORKSPACE_FOLDER_PATHS, platform);
  if (!folder) return undefined;
  env.CLAUDE_USER_CWD = folder;
  return folder;
}

/**
 * Claude Code same-root exclusion stays on. Cursor Shared MCP (and a home-keyed
 * cwd) skip this process lock: reconnect spawns a second child against a live holder,
 * and GH #672 forbids stealing that holder. Device/session authority remains the
 * singleton. `--no-lock` is the Codex launcher / Cursor mcp.json flag.
 */
export function shouldAcquireProcessLock(
  argv: readonly string[] = process.argv,
  env: NodeJS.Dict<string | undefined> = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): boolean {
  if (argv.includes('--no-lock') || argv.includes('--diagnostic-contract-probe')) {
    return false;
  }
  if (isCursorHost(env)) return false;
  const root = env.CLAUDE_USER_CWD?.trim() || cwd;
  return !isHomeProjectRoot(root, home);
}
