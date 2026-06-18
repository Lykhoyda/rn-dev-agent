import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { assertValidActionId } from './path-safety.js';
import { e2eRunsDirFor } from './e2e-run.js';

export type E2eRunStatus =
  | 'requested'
  | 'reloading'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface E2eRunRequest {
  runId: string;
  status: E2eRunStatus;
  pid: number;
  createdAt: string;
  updatedAt: string;
  pattern?: string;
  progress?: { total: number; completed: number; lastTestId?: string };
}

export const TERMINAL_STATUSES: ReadonlySet<E2eRunStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

function requestsDir(projectRoot: string): string {
  return join(e2eRunsDirFor(projectRoot), 'requests');
}

function requestPath(projectRoot: string, runId: string): string {
  assertValidActionId(runId, 'e2e-run-request');
  return join(requestsDir(projectRoot), `${runId}.json`);
}

export function writeRequest(projectRoot: string, req: E2eRunRequest): void {
  const file = requestPath(projectRoot, req.runId);
  mkdirSync(requestsDir(projectRoot), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(req, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function loadRequest(projectRoot: string, runId: string): E2eRunRequest | null {
  const file = requestPath(projectRoot, runId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as E2eRunRequest;
  } catch {
    return null;
  }
}

export function updateRequest(
  projectRoot: string,
  runId: string,
  patch: Partial<Omit<E2eRunRequest, 'runId'>>,
): E2eRunRequest | null {
  const cur = loadRequest(projectRoot, runId);
  if (!cur) return null;
  const next: E2eRunRequest = { ...cur, ...patch, runId };
  writeRequest(projectRoot, next);
  return next;
}

export function listRequests(projectRoot: string): E2eRunRequest[] {
  const dir = requestsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: E2eRunRequest[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const r = loadRequest(projectRoot, f.replace(/\.json$/, ''));
    if (r) out.push(r);
  }
  return out;
}

export function recoverInterruptedRequests(
  projectRoot: string,
  isPidAlive: (pid: number) => boolean,
  now: () => Date,
): string[] {
  const affected: string[] = [];
  for (const r of listRequests(projectRoot)) {
    if (TERMINAL_STATUSES.has(r.status)) continue;
    if (isPidAlive(r.pid)) continue;
    writeRequest(projectRoot, { ...r, status: 'interrupted', updatedAt: now().toISOString() });
    affected.push(r.runId);
  }
  return affected.sort();
}
