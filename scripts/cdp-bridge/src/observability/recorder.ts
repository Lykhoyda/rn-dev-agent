import { readFileSync, statSync } from 'node:fs';
import { RingBuffer } from '../ring-buffer.js';
import { mapObservation } from './events.js';
import type { AgentEvent, ToolObservation } from './events.js';

const DEFAULT_CAP = 500;
const MAX_SHOT_BYTES = 4_000_000;
export interface ScreenshotBytes { buf: Buffer; contentType: string; }

function screenshotPath(result: unknown): string | null {
  const data = (result as { data?: { message?: string; path?: string } })?.data;
  const p = data?.path ?? data?.message;
  return typeof p === 'string' && (p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.png')) ? p : null;
}

export class Recorder {
  private buf: RingBuffer<AgentEvent>;
  private seq = 0;
  private subs = new Set<(e: AgentEvent) => void>();
  private shots = new Map<number, ScreenshotBytes>();
  private readonly shotCap: number;

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
      for (const fn of this.subs) { try { fn(ev); } catch { /* per-subscriber swallow */ } }
    } catch { /* non-load-bearing: never throw into the tool path */ }
  }
  snapshot(): AgentEvent[] { return this.buf.getLast(this.buf.size); }
  attach(fn: (e: AgentEvent) => void): { snapshot: AgentEvent[]; detach: () => void } {
    const snapshot = this.buf.getLast(this.buf.size);
    this.subs.add(fn);
    return { snapshot, detach: () => { this.subs.delete(fn); } };
  }
  getScreenshot(seq: number): ScreenshotBytes | undefined { return this.shots.get(seq); }
  clear(): void { this.buf.clear(); this.subs.clear(); this.shots.clear(); this.seq = 0; }
  protected captureScreenshot(ev: AgentEvent, o: ToolObservation): void {
    if (ev.tool !== 'device_screenshot' || !ev.ok) return;
    const p = screenshotPath(o.result);
    if (!p) return;
    try {
      if (statSync(p).size > MAX_SHOT_BYTES) return;
      const buf = readFileSync(p);
      const contentType = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
      this.shots.set(ev.seq, { buf, contentType });
      while (this.shots.size > this.shotCap) {
        const oldest = this.shots.keys().next().value;
        if (oldest === undefined) break;
        this.shots.delete(oldest);
      }
    } catch { /* file vanished/unreadable — fail-safe */ }
  }
}
export const recorder = new Recorder();
