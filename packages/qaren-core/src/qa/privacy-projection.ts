import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { matchPrivate, type PrivateSet } from './privacy.js';

export const VERDICT_WITHHELD = 'Verdict text withheld: privacy policy unavailable.';
const SCHEMA = 'qaren-privacy/1';

export function persistRunPolicy(
  set: PrivateSet,
  cwd = process.cwd(),
  lease = process.env.QAREN_DEVICE_LEASE,
): void {
  const runId = lease?.split(':')[0];
  if (!runId || basename(cwd) !== 'wt' || basename(dirname(cwd)) !== runId) return;
  try {
    writeFileSync(
      join(dirname(cwd), 'privacy-policy.json'),
      JSON.stringify({
        schema: SCHEMA,
        values: set.values,
        contexts: set.contexts ?? [],
      }),
      { mode: 0o600, flag: 'wx' },
    );
  } catch {}
}

export function projectVerdict(policyPath: string, verdictPath: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return VERDICT_WITHHELD;
    const policy = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      policy?.schema !== SCHEMA ||
      !Array.isArray(policy.values) ||
      !Array.isArray(policy.contexts)
    )
      return VERDICT_WITHHELD;
    if (
      !policy.values.every(
        (value: { text?: unknown; provenance?: unknown }) =>
          value &&
          typeof value.text === 'string' &&
          ['typed', 'observed', 'concealed', 'secret'].includes(String(value.provenance)),
      )
    )
      return VERDICT_WITHHELD;
    if (
      !policy.contexts.every(
        (context: { key?: unknown; boxes?: unknown }) =>
          context &&
          typeof context.key === 'string' &&
          Array.isArray(context.boxes) &&
          context.boxes.length >= 2 &&
          context.boxes.every((box: unknown) => typeof box === 'string' && [...box].length === 1),
      )
    )
      return VERDICT_WITHHELD;
    return matchPrivate(readFileSync(verdictPath, 'utf8'), policy, 'durable').text;
  } catch {
    return VERDICT_WITHHELD;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

if (process.argv[2] === '--project-verdict') {
  const [policyPath, verdictPath] = process.argv.slice(3);
  writeFileSync(
    1,
    JSON.stringify({
      text: policyPath && verdictPath ? projectVerdict(policyPath, verdictPath) : VERDICT_WITHHELD,
    }),
  );
  process.exit(0);
}
