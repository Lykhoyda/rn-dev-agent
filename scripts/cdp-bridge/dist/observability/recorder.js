import { readFileSync, statSync } from 'node:fs';
import { RingBuffer } from '../ring-buffer.js';
import { mapObservation, unwrapResult } from './events.js';
const DEFAULT_CAP = 500;
const MAX_SHOT_BYTES = 4_000_000;
function screenshotPath(result) {
    const data = (unwrapResult(result)?.data ?? result?.data);
    const p = data?.path ?? data?.message;
    return typeof p === 'string' && (p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.png')) ? p : null;
}
export class Recorder {
    buf;
    seq = 0;
    subs = new Set();
    shots = new Map();
    shotCap;
    constructor(capacity = DEFAULT_CAP) {
        this.buf = new RingBuffer(capacity);
        this.shotCap = Math.max(8, Math.floor(capacity / 10));
    }
    record(o) {
        try {
            if (!o || typeof o !== 'object' || typeof o.tool !== 'string')
                return;
            const ev = mapObservation(++this.seq, o);
            this.buf.push(ev);
            this.captureScreenshot(ev, o);
            for (const fn of this.subs) {
                try {
                    fn(ev);
                }
                catch { /* per-subscriber swallow */ }
            }
        }
        catch { /* non-load-bearing: never throw into the tool path */ }
    }
    snapshot() { return this.buf.getLast(this.buf.size); }
    attach(fn) {
        const snapshot = this.buf.getLast(this.buf.size);
        this.subs.add(fn);
        return { snapshot, detach: () => { this.subs.delete(fn); } };
    }
    getScreenshot(seq) { return this.shots.get(seq); }
    clear() { this.buf.clear(); this.subs.clear(); this.shots.clear(); this.seq = 0; }
    captureScreenshot(ev, o) {
        if (ev.tool !== 'device_screenshot' || !ev.ok)
            return;
        const p = screenshotPath(o.result);
        if (!p)
            return;
        try {
            if (statSync(p).size > MAX_SHOT_BYTES)
                return;
            const buf = readFileSync(p);
            const contentType = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
            this.shots.set(ev.seq, { buf, contentType });
            while (this.shots.size > this.shotCap) {
                const oldest = this.shots.keys().next().value;
                if (oldest === undefined)
                    break;
                this.shots.delete(oldest);
            }
        }
        catch { /* file vanished/unreadable — fail-safe */ }
    }
}
export const recorder = new Recorder();
