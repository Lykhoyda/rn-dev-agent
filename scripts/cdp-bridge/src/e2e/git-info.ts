import { execFileSync } from 'node:child_process';

export type GitExec = (cmd: string, args: string[]) => string;

const defaultExec: GitExec = (cmd, args) =>
  execFileSync(cmd, args, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function getGitInfo(
  projectRoot: string,
  exec: GitExec = (cmd, args) => defaultExec(cmd, ['-C', projectRoot, ...args]),
): { sha: string | null; dirty: boolean } {
  try {
    const sha = exec('git', ['rev-parse', '--short', 'HEAD']).trim() || null;
    const status = exec('git', ['status', '--porcelain']).trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    return { sha: null, dirty: false };
  }
}
