import { join } from 'node:path';
import {
  getStateDir,
  writeJsonStateFileAtomic,
  readJsonStateFile,
  deleteStateFile,
} from '../util/secure-state-file.js';
import { findProjectRoot } from '../nav-graph/storage.js';

/**
 * Spec 2026-07-02 (observe autostart): best-effort discovery aid. The MCP
 * worker records where the observe UI is listening so out-of-band consumers
 * (SessionStart hook, doctor, humans) can find the live URL without calling
 * the tool. Uses the GH #383 hardened state-file helpers (atomic writes,
 * symlink-refusing reads, per-user app-support dir). Every function here is
 * fail-safe: state-file problems must never affect the observe server itself.
 */
export interface ObserveState {
  url: string;
  port: number;
  pid: number;
  projectRoot: string;
  startedAt: string;
}

export function observeStatePath(projectRoot: string): string {
  const safe = projectRoot.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(getStateDir(), 'observe', `${safe}.json`);
}

export function writeObserveState(
  url: string,
  port: number,
  projectRoot: string | null = findProjectRoot(),
  now: () => Date = () => new Date(),
): void {
  try {
    if (!projectRoot) return;
    const state: ObserveState = {
      url,
      port,
      pid: process.pid,
      projectRoot,
      startedAt: now().toISOString(),
    };
    writeJsonStateFileAtomic(observeStatePath(projectRoot), state);
  } catch {
    /* best-effort — never fail the caller */
  }
}

export function removeObserveState(projectRoot: string | null = findProjectRoot()): void {
  try {
    if (!projectRoot) return;
    const p = observeStatePath(projectRoot);
    const existing = readJsonStateFile<ObserveState>(p);
    // A different pid means another live session overwrote the file after we
    // started (port-collision fallback scenario) — their record, not ours.
    if (existing && existing.pid !== process.pid) return;
    deleteStateFile(p);
  } catch {
    /* best-effort */
  }
}
