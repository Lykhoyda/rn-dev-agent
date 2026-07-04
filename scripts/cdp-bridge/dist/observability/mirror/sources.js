// scripts/cdp-bridge/src/observability/mirror/sources.ts
import { spawn, execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JpegFrameExtractor } from './jpeg-stream.js';
export class RestartGate {
    limit;
    windowMs;
    now;
    exits = [];
    constructor(limit = 3, windowMs = 10_000, now = Date.now) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.now = now;
    }
    record() {
        const t = this.now();
        this.exits = this.exits.filter((e) => t - e < this.windowMs);
        this.exits.push(t);
        return this.exits.length < this.limit;
    }
}
export const SIMCTL_HINT = 'install idb for smoother mirroring (brew install idb-companion && pipx install fb-idb)';
const IDB_HINT = 'idb not found — brew install idb-companion && pipx install fb-idb';
const FFMPEG_HINT = 'ffmpeg not found — run scripts/ensure-ffmpeg.sh or brew install ffmpeg';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// setTimeout(fn, 0) is clamped and raced against the timers phase, so a 0ms
// restart delay (as used by tests) can lag an arbitrary number of event-loop
// turns behind. setImmediate fires deterministically on the very next turn,
// which is what "no delay" should mean in practice.
const scheduleAfter = (fn, delayMs) => {
    if (delayMs <= 0)
        setImmediate(fn);
    else
        setTimeout(fn, delayMs);
};
const defaultSpawn = (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
export async function detectIdb(execFileFn = execFile) {
    return new Promise((resolve) => {
        execFileFn('which', ['idb'], { timeout: 3000 }, (err) => resolve(!err));
    });
}
function isEnoent(err) {
    return !!err && typeof err === 'object' && err.code === 'ENOENT';
}
export class IosIdbSource {
    udid;
    pipeline = 'idb';
    nominalFps;
    active = false;
    proc = null;
    spawnFn;
    gate;
    restartDelayMs;
    constructor(udid, fps, opts = {}) {
        this.udid = udid;
        this.nominalFps = fps;
        this.spawnFn = opts.spawnFn ?? defaultSpawn;
        this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
        this.restartDelayMs = opts.restartDelayMs ?? 300;
    }
    start(sink) {
        this.active = true;
        this.spawnOnce(sink);
    }
    spawnOnce(sink) {
        const extractor = new JpegFrameExtractor();
        const proc = this.spawnFn('idb', [
            'video-stream',
            '--udid',
            this.udid,
            '--fps',
            String(this.nominalFps),
            '--format',
            'mjpeg',
            '--compression-quality',
            '0.7',
        ]);
        this.proc = proc;
        // Undrained stderr can fill the 64KB pipe and block the child mid-write —
        // resume() discards it.
        proc.stderr?.resume();
        proc.stdout.on('data', (chunk) => {
            if (!this.active)
                return;
            for (const frame of extractor.push(chunk)) {
                if (this.active)
                    sink.onFrame(frame);
            }
        });
        proc.on('error', (err) => {
            if (!this.active)
                return;
            if (isEnoent(err)) {
                this.active = false;
                sink.onExit({ reason: 'idb not found', hint: IDB_HINT });
            }
        });
        proc.on('close', () => {
            if (!this.active)
                return;
            if (this.gate.record()) {
                scheduleAfter(() => {
                    if (this.active)
                        this.spawnOnce(sink);
                }, this.restartDelayMs);
            }
            else {
                this.active = false;
                sink.onExit({ reason: 'idb video-stream keeps exiting' });
            }
        });
    }
    stop() {
        this.active = false;
        this.proc?.kill();
    }
}
export class IosSimctlLoopSource {
    udid;
    pipeline = 'simctl';
    nominalFps = 6;
    active = false;
    execJpeg;
    gate;
    idleDelayMs;
    failurePauseMs;
    tmpPath;
    constructor(udid, opts = {}) {
        this.udid = udid;
        this.execJpeg = opts.execJpeg ?? defaultExecJpeg;
        this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
        this.idleDelayMs = opts.idleDelayMs ?? 25;
        this.failurePauseMs = opts.failurePauseMs ?? 500;
        this.tmpPath =
            opts.tmpPath ?? (() => join(tmpdir(), 'rn-mirror-simctl-' + process.pid + '.jpg'));
    }
    start(sink) {
        this.active = true;
        void this.loop(sink);
    }
    async loop(sink) {
        while (this.active) {
            try {
                const buf = await this.execJpeg('xcrun', [
                    'simctl',
                    'io',
                    this.udid,
                    'screenshot',
                    '--type=jpeg',
                    this.tmpPath(),
                ]);
                // A capture already in flight runs to completion and delivers its
                // frame even if stop() lands mid-capture; only the *next* iteration
                // honors the stop.
                sink.onFrame(buf);
                if (!this.active)
                    break;
                await sleep(this.idleDelayMs);
            }
            catch {
                if (!this.gate.record()) {
                    if (this.active)
                        sink.onExit({ reason: 'simctl screenshot failing', hint: SIMCTL_HINT });
                    this.active = false;
                    break;
                }
                await sleep(this.failurePauseMs);
            }
        }
    }
    stop() {
        this.active = false;
    }
}
// simctl's `screenshot --type=jpeg -` is documented as writing to stdout when
// the target is `-`, but on current Xcode/simctl builds this is broken: it
// instead writes a literal file named `-` in the process cwd (and logs
// "Wrote screenshot to: <cwd>/-" on stderr); passing `/dev/stdout` errors
// outright. So the default capture path goes through a real tmp file — the
// last element of `args` is, by construction, that output path — and reads
// it back once simctl exits.
function defaultExecJpeg(cmd, args) {
    const outPath = args[args.length - 1];
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err) => {
            if (err) {
                reject(err);
                return;
            }
            readFile(outPath)
                .then((buf) => {
                void unlink(outPath).catch(() => { });
                resolve(buf);
            })
                .catch((readErr) => {
                void unlink(outPath).catch(() => { });
                reject(readErr);
            });
        });
    });
}
export class AndroidScreenrecordSource {
    serial;
    pipeline = 'screenrecord';
    nominalFps = 25;
    active = false;
    adb = null;
    ffmpeg = null;
    spawnFn;
    gate;
    restartDelayMs;
    constructor(serial, opts = {}) {
        this.serial = serial;
        this.spawnFn = opts.spawnFn ?? defaultSpawn;
        this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
        this.restartDelayMs = opts.restartDelayMs ?? 300;
    }
    start(sink) {
        this.active = true;
        this.spawnCycle(sink);
    }
    spawnCycle(sink) {
        let cycleDone = false;
        const extractor = new JpegFrameExtractor();
        const adb = this.spawnFn('adb', [
            '-s',
            this.serial,
            'exec-out',
            'screenrecord',
            '--output-format=h264',
            '--time-limit=179',
            '-',
        ]);
        const ffmpeg = this.spawnFn('ffmpeg', [
            '-loglevel',
            'error',
            '-fflags',
            'nobuffer',
            '-f',
            'h264',
            '-i',
            'pipe:0',
            '-q:v',
            '7',
            '-f',
            'mjpeg',
            'pipe:1',
        ]);
        this.adb = adb;
        this.ffmpeg = ffmpeg;
        adb.stderr?.resume();
        ffmpeg.stderr?.resume();
        if (ffmpeg.stdin) {
            // pipe() does not forward destination errors: if ffmpeg dies mid-write,
            // an unhandled EPIPE on its stdin would crash the bridge process. The
            // process-level close/error handlers own recovery; this only swallows.
            ffmpeg.stdin.on('error', () => { });
            adb.stdout.pipe(ffmpeg.stdin);
        }
        ffmpeg.stdout.on('data', (chunk) => {
            if (!this.active)
                return;
            for (const frame of extractor.push(chunk)) {
                if (this.active)
                    sink.onFrame(frame);
            }
        });
        const killSibling = (self) => {
            if (self === 'adb')
                ffmpeg.kill();
            else
                adb.kill();
        };
        adb.on('error', (err) => {
            if (!this.active || cycleDone)
                return;
            if (isEnoent(err)) {
                cycleDone = true;
                this.active = false;
                killSibling('adb');
                sink.onExit({ reason: 'adb not found' });
            }
        });
        ffmpeg.on('error', (err) => {
            if (!this.active || cycleDone)
                return;
            if (isEnoent(err)) {
                cycleDone = true;
                this.active = false;
                killSibling('ffmpeg');
                sink.onExit({ reason: 'ffmpeg not found', hint: FFMPEG_HINT });
            }
        });
        const onClose = (self) => {
            if (!this.active || cycleDone)
                return;
            cycleDone = true;
            killSibling(self);
            if (this.gate.record()) {
                scheduleAfter(() => {
                    if (this.active)
                        this.spawnCycle(sink);
                }, this.restartDelayMs);
            }
            else {
                this.active = false;
                sink.onExit({ reason: 'screen capture pipeline keeps exiting' });
            }
        };
        adb.on('close', () => onClose('adb'));
        ffmpeg.on('close', () => onClose('ffmpeg'));
    }
    stop() {
        this.active = false;
        this.adb?.kill();
        this.ffmpeg?.kill();
    }
}
export async function createMirrorSource(target, fps) {
    if (target.platform === 'android') {
        return new AndroidScreenrecordSource(target.deviceId);
    }
    const hasIdb = await detectIdb();
    return hasIdb ? new IosIdbSource(target.deviceId, fps) : new IosSimctlLoopSource(target.deviceId);
}
