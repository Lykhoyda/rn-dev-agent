import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Cursor WORKSPACE_FOLDER_PATHS: JSON array or `:`/`;` paths. Read env, not `$VAR` in args. */
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
  return Boolean(
    env.CURSOR_PLUGIN_ROOT?.trim() || firstWorkspaceFolder(env.WORKSPACE_FOLDER_PATHS),
  );
}

export function isHomeProjectRoot(root: string, home: string = homedir()): boolean {
  return resolve(root) === resolve(home);
}

/** Fill CLAUDE_USER_CWD from the first workspace folder. Does not chdir. */
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

/** Skip lock on --no-lock, Cursor, or home-keyed root. Claude same-root still acquires (GH #672). */
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
