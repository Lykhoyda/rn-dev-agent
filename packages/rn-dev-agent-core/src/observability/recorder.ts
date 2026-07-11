import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { RingBuffer } from '../ring-buffer.js';
import { mapObservation, unwrapResult } from './events.js';
import type { AgentEvent, ToolObservation } from './events.js';

const DEFAULT_CAP = 500;
const MAX_SHOT_BYTES = 4_000_000;
// GH #429: how many capture-registered paths to remember. Each successful
// device_screenshot registers 1-2 paths and the very next observation
// consumes one, so the bound only matters for pipelines (proof_step,
// device_batch) whose registrations are never consumed.
const SHOT_REGISTRY_CAP = 64;
export interface ScreenshotBytes {
  buf: Buffer;
  contentType: string;
}

// GH #422: absolute paths only — a runner-internal relative path (e.g. iOS
// "tmp/…") would resolve against the bridge cwd, silently blanking the panel
// or reading an unrelated file that shares the name.
// GH #429: exported so the capture pipeline can grant exactly the path this
// extractor will later pull out of the observation — envelope wrapping can
// rewrite data.path, and legacy envelopes carry the file in data.message,
// so grants derived any other way can miss the consumed path.
export function extractScreenshotPath(result: unknown): string | null {
  const data = (unwrapResult(result)?.data ?? (result as { data?: unknown })?.data) as
    | { message?: string; path?: string }
    | undefined;
  const p = data?.path ?? data?.message;
  return typeof p === 'string' &&
    isAbsolute(p) &&
    (p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.png'))
    ? p
    : null;
}

// GH #429: TOCTOU-safe bounded read. One descriptor for the whole
// check-then-read (a stat-then-readFileSync pair can be raced by swapping the
// file between the two calls); O_NOFOLLOW refuses symlinks outright and
// O_NONBLOCK keeps a FIFO planted at the path from hanging the open. Reading
// size+1 bytes detects a file that grew past the fstat between the two calls.
function readShotBounded(p: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SHOT_BYTES) return null;
    const size = Number(st.size);
    const buf = Buffer.alloc(size + 1);
    const n = readSync(fd, buf, 0, size + 1, 0);
    if (n > size) return null;
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

export class Recorder {
  private buf: RingBuffer<AgentEvent>;
  private seq = 0;
  private subs = new Set<(e: AgentEvent) => void>();
  private shots = new Map<number, ScreenshotBytes>();
  // GH #429: single-use trust grants from the capture pipeline (insertion-
  // ordered, FIFO-evicted). Observations name paths, but only paths this
  // process just captured may be read back — otherwise any tool result that
  // mentions "/…/x.png" becomes an arbitrary local file read served over the
  // observe server.
  private trustedShotPaths = new Set<string>();
  private readonly shotCap: number;
  private liveShotData: ScreenshotBytes | undefined;
  private liveSeqVal = 0;

  constructor(capacity: number = DEFAULT_CAP) {
    this.buf = new RingBuffer<AgentEvent>(capacity);
    this.shotCap = Math.max(8, Math.floor(capacity / 10));
  }
  record(o: ToolObservation): void {
    try {
      if (!o || typeof o !== 'object' || typeof o.tool !== 'string') return;
      const ev = mapObservation(++this.seq, o);
      this.buf.push(ev);
      this.captureScreenshot(ev, o);
      for (const fn of this.subs) {
        try {
          fn(ev);
        } catch {
          /* per-subscriber swallow */
        }
      }
    } catch {
      /* non-load-bearing: never throw into the tool path */
    }
  }
  snapshot(): AgentEvent[] {
    return this.buf.getLast(this.buf.size);
  }
  attach(fn: (e: AgentEvent) => void): { snapshot: AgentEvent[]; detach: () => void } {
    const snapshot = this.buf.getLast(this.buf.size);
    this.subs.add(fn);
    return {
      snapshot,
      detach: () => {
        this.subs.delete(fn);
      },
    };
  }
  getScreenshot(seq: number): ScreenshotBytes | undefined {
    return this.shots.get(seq);
  }
  /**
   * GH #429: grant a one-shot read for a file the capture pipeline just
   * wrote. `captureScreenshot` consumes the grant on first use, so a later
   * observation replaying the same path is refused. User-chosen destinations
   * (docs/proof/…, ~/Desktop/…) keep working because the grant is issued for
   * whatever path the pipeline actually captured to.
   */
  registerCapturedScreenshot(p: string): void {
    if (typeof p !== 'string' || !isAbsolute(p)) return;
    this.trustedShotPaths.delete(p);
    this.trustedShotPaths.add(p);
    while (this.trustedShotPaths.size > SHOT_REGISTRY_CAP) {
      const oldest = this.trustedShotPaths.values().next().value;
      if (oldest === undefined) break;
      this.trustedShotPaths.delete(oldest);
    }
  }
  hasSubscribers(): boolean {
    return this.subs.size > 0;
  }
  getLiveScreenshot(): ScreenshotBytes | undefined {
    return this.liveShotData;
  }
  pushLive(frame: { shot?: ScreenshotBytes; route?: string }): void {
    const ev: Record<string, unknown> = { type: 'live' };
    let changed = false;
    if (frame.shot && frame.shot.buf.length <= MAX_SHOT_BYTES) {
      this.liveShotData = frame.shot;
      ev.shotSeq = ++this.liveSeqVal;
      changed = true;
    }
    if (typeof frame.route === 'string' && frame.route.length > 0) {
      ev.route = frame.route;
      changed = true;
    }
    if (!changed) return;
    for (const fn of this.subs) {
      try {
        fn(ev as unknown as AgentEvent);
      } catch {
        /* per-subscriber swallow */
      }
    }
  }
  push(ev: { type: string; [k: string]: unknown }): void {
    for (const fn of this.subs) {
      try {
        fn(ev as unknown as AgentEvent);
      } catch {
        /* per-subscriber swallow */
      }
    }
  }
  clear(): void {
    this.buf.clear();
    // Notify live subscribers with a terminal sentinel BEFORE dropping them, so
    // a clear() (e.g. a future "reset session") can't silently orphan an open
    // SSE stream + its heartbeat interval. The server's stream subscriber ends
    // the response on this event.
    for (const fn of this.subs) {
      try {
        fn({ type: 'cleared' } as unknown as AgentEvent);
      } catch {
        /* per-subscriber swallow */
      }
    }
    this.subs.clear();
    this.shots.clear();
    this.trustedShotPaths.clear();
    this.seq = 0;
    this.liveShotData = undefined;
    this.liveSeqVal = 0;
  }
  protected captureScreenshot(ev: AgentEvent, o: ToolObservation): void {
    if (ev.tool !== 'device_screenshot' || !ev.ok) return;
    const p = extractScreenshotPath(o.result);
    // GH #429: consume-on-attempt — a grant is spent even when the read
    // fails, so a vanished file can't leave a live grant behind for a
    // later forged observation naming the same path.
    if (!p || !this.trustedShotPaths.delete(p)) return;
    const buf = readShotBounded(p);
    if (!buf) return;
    const contentType = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
    this.shots.set(ev.seq, { buf, contentType });
    while (this.shots.size > this.shotCap) {
      const oldest = this.shots.keys().next().value;
      if (oldest === undefined) break;
      this.shots.delete(oldest);
    }
  }
}
export const recorder = new Recorder();
